/* Hymn Sheet: one live page per job that the whole crew works from. */
(function () {
  'use strict';

  var API = window.HYMN_API || '';
  var POLL_MS = 8000;
  var DEPTS = ['Camera', 'Focus', 'Video', 'Grip', 'Lighting', 'DIT', 'Director', 'On the day', 'Other'];
  var SUPPLIERS = ['TBC', 'Rental house', 'Production', 'Own kit', 'Elliot'];

  var params = new URLSearchParams(location.search);
  var key = params.get('k') || store('hymn_key') || '';
  if (params.get('k')) store('hymn_key', key);

  var S = load('hymn_state_' + key);   // last state from the server
  var queue = load('hymn_queue_' + key) || [];
  var ui = { tab: store('hymn_tab') || 'kit', filter: 'all', open: null, adding: false, editJob: false, addCrew: false, crewOpen: null };
  var status = { text: '', bad: false };
  var busy = false, pollTimer = null, lastOk = 0;

  var root = document.getElementById('app');

  /* ---------- storage ---------- */
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch (e) { return null; }
  }
  function load(k) { try { return JSON.parse(store(k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { store(k, JSON.stringify(v)); }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
  function byDept(a, b) {
    var ia = DEPTS.indexOf(a), ib = DEPTS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(b);
  }
  function first(name) { return String(name || '').split(' ')[0]; }
  // Laptops: open a Gmail draft in a new tab (mailto: does nothing without a mail app).
  // Phones: mailto opens whichever mail app they use.
  var DESK = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  function mailto(list, subject, body) {
    var to = list.filter(Boolean).join(',');
    if (DESK) return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(to) + '&su=' + encodeURIComponent(subject || '') + (body ? '&body=' + encodeURIComponent(body) : '');
    return 'mailto:' + to + '?subject=' + encodeURIComponent(subject || '') + (body ? '&body=' + encodeURIComponent(body) : '');
  }
  function linkFor(k) { return location.origin + location.pathname + '?k=' + encodeURIComponent(k); }

  /* ---------- server ---------- */
  function get() {
    return fetch(API + '?a=state&k=' + encodeURIComponent(key), { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function post(op) {
    var body = JSON.stringify(Object.assign({}, op, { k: key }));
    return fetch(API, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } })
      .then(function (r) { return r.json(); });
  }

  function took(data) {
    if (data && data.error) { status = { text: data.error, bad: true }; return false; }
    S = data; save('hymn_state_' + key, S); lastOk = Date.now();
    status = { text: '', bad: false };
    return true;
  }

  // Don't redraw under someone's thumbs while they're typing in a form.
  function typing() {
    var a = document.activeElement;
    return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && root.contains(a));
  }

  function refresh() {
    if (!API || !key || busy) return Promise.resolve();
    if (queue.length) return flush();
    return get().then(function (d) {
      if (d && d.error && !S) { fatal(d.error); return; }
      took(d);
      if (typing()) paintStatus(); else render();
    }).catch(function () { offline(); });
  }

  // Changes go into a queue first, so ticks made with no signal are sent later.
  function send(op, optimistic) {
    queue.push(op); save('hymn_queue_' + key, queue);
    if (optimistic) { try { optimistic(); } catch (e) {} }
    render();
    return flush();
  }

  function flush() {
    if (busy || !queue.length) return Promise.resolve();
    busy = true; status = { text: 'Saving…', bad: false }; paintStatus();
    var op = queue[0];
    return post(op).then(function (d) {
      queue.shift(); save('hymn_queue_' + key, queue);
      busy = false;
      var ok = took(d);
      if (!ok) { var msg = status.text; get().then(function (x) { took(x); status = { text: msg, bad: true }; render(); }); }
      render();
      if (queue.length) return flush();
    }).catch(function () { busy = false; offline(); });
  }

  function offline() {
    status = { text: queue.length ? 'No signal. ' + queue.length + ' change' + (queue.length > 1 ? 's' : '') + ' will send when you\'re back.' : 'No signal. Showing the last copy.', bad: true };
    paintStatus();
  }

  function fatal(msg) {
    root.innerHTML = '<div class="wrap"><p class="brand">Hymn Sheet</p><p class="gap">' + esc(msg) + '</p></div>';
  }

  /* ---------- derived ---------- */
  function openFlags() {
    var out = (S.flags || []).filter(function (f) { return f.status !== 'sorted'; }).map(function (f) {
      return { id: f.id, text: f.text, by: f.raised_by || f.source, time: f.time, manual: true };
    });
    var noSup = S.items.filter(function (i) { return !i.supplier || same(i.supplier, 'TBC'); });
    if (noSup.length) out.push({ text: noSup.length + ' item' + (noSup.length > 1 ? 's' : '') + ' with no supplier: ' + noSup.slice(0, 4).map(function (i) { return i.item; }).join(', ') + (noSup.length > 4 ? '…' : ''), auto: 'nosupplier' });
    var unc = S.items.filter(function (i) { return !i.confirmed; });
    if (unc.length) out.push({ text: unc.length + ' item' + (unc.length > 1 ? 's' : '') + ' not confirmed by Elliot yet', auto: 'unconfirmed' });
    var counts = {};
    S.items.forEach(function (i) { var k = i.item.trim().toLowerCase(); counts[k] = (counts[k] || []).concat(i); });
    Object.keys(counts).forEach(function (k) {
      var l = counts[k];
      if (l.length > 1) {
        var sups = l.map(function (i) { return i.supplier; }).filter(function (v, x, a) { return a.indexOf(v) === x; });
        out.push({ text: '"' + l[0].item + '" is on the list ' + l.length + ' times' + (sups.length > 1 ? ' from ' + sups.join(' and ') : ''), auto: 'dupe' });
      }
    });
    return out;
  }

  function myTasks() { return S.tasks.filter(function (t) { return same(t.who, S.me.name) || same(t.who, 'everyone'); }); }
  function myItems() { return S.items.filter(function (i) { return same(i.owner, S.me.name) || same(i.asked_by, S.me.name); }); }
  function tasksOf(name) { return S.tasks.filter(function (t) { return same(t.who, name); }); }

  /* ---------- render ---------- */
  function render() {
    if (!S) return;
    var active = document.activeElement;
    var keepId = active && active.id, keepVal = active && active.value, keepPos = active && active.selectionStart;
    var forms = {};
    Array.prototype.forEach.call(root.querySelectorAll('[data-keep]'), function (el) { forms[el.getAttribute('data-keep')] = el.value; });

    var h = '<div class="wrap">' + header() + tabs() + '<main>';
    if (ui.tab === 'kit') h += kitView();
    else if (ui.tab === 'mine') h += mineView();
    else if (ui.tab === 'crew') h += crewView();
    else if (ui.tab === 'notes' || ui.tab === 'shots') h += notesView() + shotsView();
    else h += logView();
    h += '</main><footer>Elliot Holbrow · DP</footer></div><div id="status"></div>';
    root.innerHTML = h;

    Object.keys(forms).forEach(function (k) { var el = root.querySelector('[data-keep="' + k + '"]'); if (el) el.value = forms[k]; });
    if (keepId) {
      var el = document.getElementById(keepId);
      if (el) { el.focus(); if (keepVal !== undefined && el.value !== keepVal && el.tagName !== 'SELECT') el.value = keepVal; try { el.setSelectionRange(keepPos, keepPos); } catch (e) {} }
    }
    paintStatus();
  }

  function paintStatus() {
    var el = document.getElementById('status');
    if (!el) return;
    el.className = status.text ? (status.bad ? 'show bad' : 'show') : '';
    el.textContent = status.text;
  }

  function header() {
    var j = S.job;
    var items = S.items, conf = items.filter(function (i) { return i.confirmed; }).length, packed = items.filter(function (i) { return i.packed; }).length;
    var h = '<header>';
    h += '<div class="top"><span class="brand">Hymn Sheet</span><span class="me">' + esc(S.me.name) + (S.me.role ? ' · ' + esc(S.me.role) : '') + '</span></div>';
    h += '<h1>' + esc(j.title || j.job) + '</h1>';
    h += '<dl class="facts">';
    if (j.dates) h += '<dt>Shoot</dt><dd>' + esc(j.dates) + '</dd>';
    if (j.call) h += '<dt>Call</dt><dd>' + esc(j.call) + '</dd>';
    if (j.location) h += '<dt>Where</dt><dd>' + esc(j.location) + '</dd>';
    if (j.prep) h += '<dt>Prep</dt><dd>' + esc(j.prep) + '</dd>';
    if (j.notes) h += '<dt>Note</dt><dd>' + esc(j.notes) + '</dd>';
    if (j.deck) h += '<dt>Deck</dt><dd><a href="' + esc(j.deck) + '" target="_blank" rel="noopener">DP notes</a></dd>';
    h += '</dl>';
    h += '<p class="count">Kit ' + items.length + ' · confirmed ' + conf + ' · packed ' + packed + '</p>';
    if (S.me.admin) {
      h += '<p><button class="link" data-act="editjob">' + (ui.editJob ? 'Close' : 'Edit job') + '</button></p>';
      if (ui.editJob) {
        h += '<form class="box" data-form="job">';
        [['title', 'Title'], ['dates', 'Shoot'], ['call', 'Call'], ['location', 'Where'], ['prep', 'Prep'], ['notes', 'Note'], ['deck', 'Deck link']].forEach(function (f) {
          h += '<label>' + f[1] + '<input name="' + f[0] + '" id="job_' + f[0] + '" value="' + esc(j[f[0]]) + '"></label>';
        });
        h += '<button type="submit">Save job</button></form>';
      }
    }
    h += '</header>';
    return h;
  }

  function tabs() {
    var flags = openFlags().length;
    var t = [['kit', 'Kit'], ['mine', 'Mine'], ['notes', 'Notes'], ['crew', 'Crew'], ['log', 'Log']];
    return '<nav>' + t.map(function (x) {
      var extra = '';
      if (x[0] === 'mine') { var open = myTasks().filter(function (k) { return !k.done; }).length; if (open) extra = ' (' + open + ')'; }
      if (x[0] === 'kit' && flags) extra = ' <span class="red">(' + flags + ')</span>';
      return '<button class="' + (ui.tab === x[0] || (x[0] === 'notes' && ui.tab === 'shots') ? 'on' : '') + '" data-tab="' + x[0] + '">' + x[1] + extra + '</button>';
    }).join('') + '</nav>';
  }

  function flagsBlock() {
    var f = openFlags();
    if (!f.length) return '';
    var h = '<section class="flags"><h2 class="red">Flags (' + f.length + ')</h2><ol>';
    var all = f.length;
    if (!ui.allFlags && all > 3) f = f.slice(0, 3);
    f.forEach(function (x) {
      h += '<li><span>' + esc(x.text) + (x.by ? ' <i>' + esc(x.by) + (x.time ? ', ' + esc(x.time) : '') + '</i>' : '') + '</span>';
      if (x.manual && S.me.admin) h += '<button class="link" data-act="flag" data-id="' + esc(x.id) + '">Sorted</button>';
      if (x.auto === 'unconfirmed' && S.me.admin) h += '<button class="link" data-act="filter" data-f="unconfirmed">Show</button>';
      if (x.auto === 'nosupplier') h += '<button class="link" data-act="filter" data-f="nosupplier">Show</button>';
      h += '</li>';
    });
    if (all > 3) h += '<li><button class="link" data-act="allflags">' + (ui.allFlags ? 'Show fewer' : 'Show all ' + all) + '</button></li>';
    return h + '</ol></section>';
  }

  function kitView() {
    var h = flagsBlock();
    var filters = [['all', 'All'], ['unconfirmed', 'Not confirmed'], ['unpacked', 'Not packed'], ['nosupplier', 'No supplier']];
    h += '<div class="filters">' + filters.map(function (f) {
      return '<button class="' + (ui.filter === f[0] ? 'on' : '') + '" data-act="filter" data-f="' + f[0] + '">' + f[1] + '</button>';
    }).join('') + '</div>';
    var list = S.items.filter(function (i) {
      if (ui.filter === 'unconfirmed') return !i.confirmed;
      if (ui.filter === 'unpacked') return !i.packed;
      if (ui.filter === 'nosupplier') return !i.supplier || same(i.supplier, 'TBC');
      return true;
    });
    var groups = {};
    list.forEach(function (i) { (groups[i.dept || 'Other'] = groups[i.dept || 'Other'] || []).push(i); });
    var names = Object.keys(groups).sort(byDept);
    if (!names.length) h += '<p class="grey gap">Nothing here.</p>';
    names.forEach(function (d) {
      h += '<section><h2>' + esc(d) + ' <span class="grey">(' + groups[d].length + ')</span></h2><ul class="items">';
      groups[d].forEach(function (i) { h += itemRow(i); });
      h += '</ul></section>';
    });
    h += addItemBlock();
    h += '<p class="grey small gap">Tick the box when it\'s packed at prep. Anything new goes on here, not WhatsApp.</p>';
    return h;
  }

  function itemRow(i) {
    var open = ui.open === i.id;
    var h = '<li class="item' + (i.packed ? ' packed' : '') + (open ? ' open' : '') + '">';
    h += '<button class="box' + (i.packed ? ' on' : '') + '" data-act="pack" data-id="' + esc(i.id) + '" aria-label="Packed">' + (i.packed ? '×' : '') + '</button>';
    h += '<div class="body" data-act="openitem" data-id="' + esc(i.id) + '">';
    h += '<div class="name">' + esc(i.item) + (i.qty && i.qty !== '1' ? ' <span class="grey">×' + esc(i.qty) + '</span>' : '') + '</div>';
    var meta = [];
    function tag(cls, text) { return '<span class="tag ' + cls + '">' + text + '</span>'; }
    meta.push(!i.supplier || same(i.supplier, 'TBC') ? tag('t-red red', 'no supplier') : tag('t-blue', esc(i.supplier)));
    if (i.owner && !same(i.owner, i.asked_by)) meta.push(tag('t-plain', 'with ' + esc(first(i.owner))));
    if (i.asked_by) meta.push(tag('t-plain', 'asked ' + esc(first(i.asked_by))));
    meta.push(i.confirmed ? tag('t-green', 'confirmed') : tag('t-yellow amber', 'not confirmed'));
    if (i.packed) meta.push(tag('t-grey', 'packed ' + esc(first(i.packed.split(' · ')[0]))));
    h += '<div class="meta">' + meta.join('<span class="sep"> · </span>') + '</div>';
    if (i.notes && !open) h += '<div class="meta note">' + esc(i.notes) + '</div>';
    h += '</div>';
    if (S.me.admin) h += '<button class="tick' + (i.confirmed ? ' on' : '') + '" data-act="confirm" data-id="' + esc(i.id) + '">' + (i.confirmed ? 'OK' : 'Confirm') + '</button>';
    h += '</li>';
    if (open) h += itemEditor(i);
    return h;
  }

  function supplierOptions(cur) {
    var list = SUPPLIERS.slice();
    if (cur && list.indexOf(cur) < 0) list.splice(1, 0, cur);
    return list.map(function (s) { return '<option' + (s === cur ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '<option value="__other">Other…</option>';
  }
  function crewOptions(cur) {
    var names = S.crew.map(function (c) { return c.name; }).concat(['Elliot']);
    if (cur && names.indexOf(cur) < 0) names.unshift(cur);
    return names.map(function (n) { return '<option' + (same(n, cur) ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
  }

  function itemEditor(i) {
    var h = '<li class="editor"><form class="box" data-form="item" data-id="' + esc(i.id) + '">';
    if (S.me.admin) {
      h += '<label>Item<input name="item" id="ed_item" value="' + esc(i.item) + '"></label>';
      h += '<label>Dept<select name="dept">' + DEPTS.map(function (d) { return '<option' + (d === i.dept ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></label>';
    }
    h += '<label>Qty<input name="qty" id="ed_qty" value="' + esc(i.qty) + '" inputmode="numeric"></label>';
    h += '<label>Supplier<select name="supplier" data-other="ed_sup_other">' + supplierOptions(i.supplier) + '</select></label>';
    h += '<input name="supplier_other" id="ed_sup_other" class="hide" placeholder="Who supplies it">';
    h += '<label>Who brings it<select name="owner">' + crewOptions(i.owner) + '</select></label>';
    h += '<label>Notes<input name="notes" id="ed_notes" value="' + esc(i.notes) + '"></label>';
    h += '<p class="grey small">Asked by ' + esc(i.asked_by || '-') + (i.source && i.source !== 'app' ? ' · from ' + esc(i.source) : '') + (i.confirmed ? ' · confirmed ' + esc(i.confirmed) : '') + (i.packed ? ' · packed ' + esc(i.packed) : '') + '</p>';
    h += '<div class="row"><button type="submit">Save</button>';
    h += '<a class="btn ask" target="_blank" rel="noopener" href="' + esc(askAbout(i)) + '">Ask about this</a>';
    h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(mailto(S.crew.map(function (c) { return c.email; }), S.job.title + ': ' + i.item, i.item + (i.qty ? ' x' + i.qty : '') + '\n\n')) + '">Email crew</a>';
    if (S.me.admin || (same(i.asked_by, S.me.name) && !i.confirmed)) h += '<button type="button" class="link red" data-act="delitem" data-id="' + esc(i.id) + '">Remove</button>';
    h += '</div></form></li>';
    return h;
  }

  function addItemBlock() {
    if (!ui.adding) return '<p class="gap"><button class="wide" data-act="adding">+ Add kit</button></p>';
    var h = '<form class="box gap" data-form="add"><h2>Add kit</h2>';
    h += '<label>Item<input name="item" id="add_item" data-keep="add_item" required placeholder="e.g. 5in monitor, cage, SDI"></label>';
    h += '<label>Qty<input name="qty" id="add_qty" data-keep="add_qty" inputmode="numeric" placeholder="1"></label>';
    var myDept = (S.crew.filter(function (c) { return same(c.name, S.me.name); })[0] || {}).dept;
    h += '<label>Dept<select name="dept" data-keep="add_dept">' + DEPTS.map(function (d) { return '<option' + (d === (myDept || 'Camera') ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></label>';
    h += '<label>Supplier<select name="supplier" data-keep="add_sup" data-other="add_sup_other">' + supplierOptions('TBC') + '</select></label>';
    h += '<input name="supplier_other" id="add_sup_other" data-keep="add_sup_other" class="hide" placeholder="Who supplies it">';
    h += '<label>Notes<input name="notes" id="add_notes" data-keep="add_notes" placeholder="optional"></label>';
    h += '<div class="row"><button type="submit">Add</button><button type="button" class="link" data-act="adding">Cancel</button></div></form>';
    return h;
  }

  function mineView() {
    var h = '';
    var mt = myTasks();
    h += '<section><h2>My tasks <span class="grey">(' + mt.filter(function (t) { return t.done; }).length + '/' + mt.length + ')</span></h2>';
    if (!mt.length) h += '<p class="grey">Nothing for you yet.</p>';
    h += '<ul class="items">' + mt.map(taskRow).join('') + '</ul></section>';

    if (!S.me.admin) {
      var meRow = S.crew.filter(function (c) { return same(c.name, S.me.name); })[0] || {};
      var mi = myItems();
      h += '<section><h2>My kit <span class="grey">(' + mi.length + ')</span></h2>';
      h += '<ul class="items">' + mi.map(itemRow).join('') + '</ul>';
      h += addItemBlock();
      h += '<p class="gap"><button class="wide' + (meRow.kit_done ? ' on' : '') + '" data-act="kitdone">' + (meRow.kit_done ? 'My kit is all on the sheet · ' + esc(meRow.kit_done) : 'I\'ve added all my kit') + '</button></p>';
      h += '<p><a class="btn wide-btn update" target="_blank" rel="noopener" href="' + esc(myUpdate()) + '">Send my update</a></p></section>';
    } else {
      h += taskAdder();
    }

    h += '<section><h2>Something wrong?</h2><form class="box" data-form="flag">';
    h += '<label>Problem<input name="text" id="flag_text" data-keep="flag_text" placeholder="e.g. no batteries for the Ember"></label>';
    h += '<div class="row"><button type="submit">Flag it</button></div></form></section>';
    return h;
  }

  function taskRow(t) {
    var h = '<li class="item' + (t.done ? ' packed' : '') + '">';
    h += '<button class="box' + (t.done ? ' on' : '') + '" data-act="task" data-id="' + esc(t.id) + '">' + (t.done ? '×' : '') + '</button>';
    h += '<div class="body"><div class="name">' + esc(t.task) + '</div><div class="meta">' + esc(t.who) + (t.due ? ' · by ' + esc(t.due) : '') + (t.done ? ' · done ' + esc(t.done.split(' · ')[1] || '') : '') + '</div></div>';
    if (S.me.admin) h += '<button class="tick" data-act="deltask" data-id="' + esc(t.id) + '">×</button>';
    return h + '</li>';
  }

  function taskAdder() {
    var h = '<section><h2>Give someone a task</h2><form class="box" data-form="task">';
    h += '<label>Who<select name="who" data-keep="task_who"><option>Everyone</option>' + crewOptions('') + '</select></label>';
    h += '<label>Task<input name="task" id="task_text" data-keep="task_text" placeholder="e.g. Check Rialto is on the MCX quote"></label>';
    h += '<label>By<input name="due" id="task_due" data-keep="task_due" placeholder="e.g. Wed 12:00"></label>';
    h += '<div class="row"><button type="submit">Add task</button></div></form></section>';
    h += '<section><h2>All tasks</h2><ul class="items">' + S.tasks.map(taskRow).join('') + '</ul></section>';
    return h;
  }

  function crewView() {
    var h = '<section><h2>Crew <span class="grey">(' + S.crew.length + ')</span></h2><ul class="crew">';
    h += '<li class="person"><span class="dot' + (S.elliotOnline ? ' on' : '') + '"></span><div class="body"><div class="name">Elliot Holbrow</div><div class="meta">DP</div></div></li>';
    S.crew.forEach(function (c, n) {
      var t = tasksOf(c.name), done = t.filter(function (x) { return x.done; }).length;
      var open = ui.crewOpen === n;
      h += '<li class="person">';
      h += '<span class="dot' + (c.online ? ' on' : '') + '" title="' + (c.online ? 'online now' : 'offline') + '"></span>';
      h += '<div class="body" data-act="crewopen" data-n="' + n + '"><div class="name">' + esc(c.name) + '</div>';
      var meta = [esc(c.role || c.dept || '')];
      meta.push(c.online ? '<span class="tag t-green">online now</span>' : c.last ? '<span class="tag t-plain">seen ' + esc(c.last) + '</span>' : '<span class="tag t-yellow amber">not opened yet</span>');
      if (t.length) meta.push('<span class="tag t-grey">tasks ' + done + '/' + t.length + '</span>');
      if (c.dept !== 'Other' && c.dept !== 'Director') meta.push(c.kit_done ? '<span class="tag t-green">kit in</span>' : '<span class="tag t-plain">kit not in</span>');
      h += '<div class="meta">' + meta.map(function (m, x) { return x ? m : '<span class="tag t-plain">' + m + '</span>'; }).join('<span class="sep"> · </span>') + '</div>';
      if (open) {
        h += '<div class="contact">';
        if (c.phone) h += '<a href="tel:' + esc(c.phone.replace(/\s/g, '')) + '">' + esc(c.phone) + '</a> ';
        if (c.email) h += '<a target="_blank" rel="noopener" href="' + esc(mailto([c.email], S.job.title)) + '">' + esc(c.email) + '</a>';
        if (S.me.admin && c.key) {
          var link = linkFor(c.key);
          if (c.email) h += '<div class="row"><a class="btn msg" target="_blank" rel="noopener" href="' + esc(messageFor(c)) + '">Message ' + esc(first(c.name)) + '</a></div>';
          h += '<div class="row"><button class="link" data-act="copy" data-text="' + esc(link) + '">Copy link</button>';
          h += '<a class="link" target="_blank" rel="noopener" href="https://wa.me/' + esc((c.phone || '').replace(/[^\d]/g, '').replace(/^0/, '44')) + '?text=' + encodeURIComponent('hey ' + first(c.name).toLowerCase() + ', everything for ' + S.job.title + ' is on here, kit, tasks & crew. add your kit & tick stuff off as it\'s sorted:\n\n' + link) + '">WhatsApp link</a>';
          if (c.email) h += '<a class="link" target="_blank" rel="noopener" href="' + esc(mailto([c.email], S.job.title + ': Hymn Sheet', 'Hey ' + first(c.name) + ',\n\nEverything for ' + S.job.title + ' is on here: kit, tasks & crew. Add your kit & tick stuff off as it\'s sorted:\n\n' + link + '\n\nThanks!\nElliot')) + '">Email link</a></div>';
        }
        h += '</div>';
      }
      h += '</div></li>';
    });
    h += '</ul>';
    var emails = S.crew.map(function (c) { return c.email; }).filter(Boolean);
    if (emails.length) h += '<p class="gap"><a class="btn" target="_blank" rel="noopener" href="' + esc(mailto(emails, S.job.title)) + '">Email everyone</a></p>';
    h += '</section>';
    if (S.me.admin) {
      if (!ui.addCrew) h += '<p><button class="wide" data-act="addcrew">+ Add crew</button></p>';
      else {
        h += '<form class="box" data-form="crew"><h2>Add crew</h2>';
        [['name', 'Name'], ['role', 'Role'], ['email', 'Email'], ['phone', 'Phone']].forEach(function (f) {
          h += '<label>' + f[1] + '<input name="' + f[0] + '" id="crew_' + f[0] + '" data-keep="crew_' + f[0] + '"' + (f[0] === 'email' ? ' type="email"' : '') + '></label>';
        });
        h += '<label>Dept<select name="dept">' + DEPTS.map(function (d) { return '<option>' + d + '</option>'; }).join('') + '</select></label>';
        h += '<div class="row"><button type="submit">Add</button><button type="button" class="link" data-act="addcrew">Cancel</button></div></form>';
      }
    }
    return h;
  }

  /* DP notes: plain text in the Sheet. "## Heading" starts a section, "- " is a bullet. */
  function sections() {
    var out = [], cur = null;
    String(S.job.dp_notes || '').split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^#{1,3}\s+(.*)/);
      if (m) { cur = { title: m[1].trim(), lines: [] }; out.push(cur); return; }
      if (!cur) { cur = { title: '', lines: [] }; out.push(cur); }
      cur.lines.push(line);
    });
    out.forEach(function (x) { while (x.lines.length && !x.lines[x.lines.length - 1].trim()) x.lines.pop(); while (x.lines.length && !x.lines[0].trim()) x.lines.shift(); });
    return out.filter(function (x) { return x.title || x.lines.length; });
  }

  function notesView() {
    var h = '';
    if (S.me.admin && ui.editNotes) {
      h += '<section><form class="box notes-edit" data-form="notes"><h2>DP notes</h2>';
      h += '<p class="grey small">"## Heading" starts a section, "- " makes a bullet. Crew see this; Message drafts pull the right sections.</p>';
      h += '<textarea name="dp_notes" id="dp_notes" rows="18">' + esc(S.job.dp_notes) + '</textarea>';
      h += '<div class="row"><button type="submit">Save notes</button><button type="button" class="link" data-act="editnotes">Cancel</button></div></form></section>';
      return h;
    }
    var secs = sections();
    if (!secs.length) h += '<p class="grey gap">No DP notes yet.</p>';
    secs.forEach(function (x) {
      h += '<section class="note-sec">' + (x.title ? '<h2>' + esc(x.title) + '</h2>' : '') + '<div class="doc">';
      var list = false;
      x.lines.forEach(function (l) {
        var b = l.match(/^\s*[-•]\s+(.*)/);
        if (b && !list) { h += '<ul class="bul">'; list = true; }
        if (!b && list) { h += '</ul>'; list = false; }
        if (b) h += '<li>' + linkify(b[1]) + '</li>';
        else if (l.trim()) h += '<p>' + linkify(l) + '</p>';
      });
      if (list) h += '</ul>';
      h += '</div></section>';
    });
    if (S.job.deck) h += '<p class="gap"><a class="btn" target="_blank" rel="noopener" href="' + esc(S.job.deck) + '">Deck (diagrams & look)</a></p>';
    if (S.me.admin) h += '<p class="gap"><button class="wide" data-act="editnotes">Edit DP notes</button></p>';
    return h;
  }

  function linkify(t) { return esc(t).replace(/https?:\/\/[^\s<]+/g, function (u) { return '<a target="_blank" rel="noopener" href="' + u + '">' + u + '</a>'; }); }

  // Which notes sections matter to which department.
  var DEPT_WORDS = {
    Camera: ['camera', 'codec', 'lens', 'move', 'rig', 'look'], Focus: ['camera', 'codec', 'lens', 'move', 'rig'],
    Video: ['monitor', 'playback', 'video', 'camera', 'codec'], DIT: ['codec', 'camera', 'data', 'dit', 'look', 'monitor', 'playback'],
    Grip: ['move', 'grip', 'rig', 'rickshaw'], Lighting: ['light', 'look'], Director: ['look', 'move', 'shot'], Other: ['playback', 'schedule']
  };
  function sectionsFor(c) {
    var words = (DEPT_WORDS[c.dept] || []).concat(String(c.role || '').toLowerCase().split(/[^a-z]+/).filter(function (w) { return w.length > 2; }));
    return sections().filter(function (x) {
      var t = x.title.toLowerCase();
      return x.title && words.some(function (w) { return t.indexOf(w) >= 0; });
    });
  }

  // A ready-to-send email to one person: their open tasks, their open kit, and the notes for their department.
  function messageFor(c) {
    var L = ['Hey ' + first(c.name) + ',', ''];
    var t = tasksOf(c.name).filter(function (x) { return !x.done; });
    if (t.length) { L.push('Your bits for ' + S.job.title + ':'); t.forEach(function (x) { L.push('- ' + x.task + (x.due ? ' (by ' + x.due + ')' : '')); }); L.push(''); }
    var k = S.items.filter(function (i) { return (same(i.owner, c.name) || same(i.asked_by, c.name)) && (!i.confirmed || !i.supplier || same(i.supplier, 'TBC')); });
    if (k.length) { L.push('Still open on your kit:'); k.forEach(function (i) { L.push('- ' + i.item + ': ' + (!i.supplier || same(i.supplier, 'TBC') ? 'no supplier yet' : 'not confirmed yet')); }); L.push(''); }
    sectionsFor(c).forEach(function (x) { L.push(x.title + ':'); x.lines.forEach(function (l) { if (l.trim()) L.push(l.replace(/^\s*•\s+/, '- ')); }); L.push(''); });
    if (c.key) { L.push('Everything\'s on here, tick stuff off as it\'s sorted:'); L.push(linkFor(c.key)); L.push(''); }
    L.push('Thanks!'); L.push('Elliot');
    return mailto([c.email], S.job.title + ' x ' + first(c.name), L.join('\n'));
  }

  /* Suggested emails for anyone on the sheet. They open in the person's own mail, ready to edit & send. */
  function production() { return S.crew.filter(function (c) { return /production manager|producer|coordinator|\bpm\b/i.test(c.role || '') && c.email; }); }
  function dpEmail() { return window.HYMN_DP_EMAIL || ''; }
  function supplierContact(sup) { return S.crew.filter(function (c) { return c.email && sup && same(c.role, sup); })[0]; }

  function askAbout(i) {
    var prod = production(), sup = supplierContact(i.supplier);
    var to = (sup ? [sup] : []).concat(prod.slice(0, 1));
    var names = to.map(function (c) { return first(c.name); });
    var L = ['Hey ' + (names.length ? names.join(' & ') : 'all') + ',', ''];
    var what = i.item + (i.qty && i.qty !== '1' ? ' x' + i.qty : '');
    if (!i.supplier || same(i.supplier, 'TBC')) L.push('Who\'s supplying the ' + what + ' for ' + S.job.title + ' (' + S.job.dates + ')? It hasn\'t got a supplier yet.');
    else L.push('Can we confirm the ' + what + ' from ' + i.supplier + ' for ' + S.job.title + ' (' + S.job.dates + ')?');
    if (i.notes) L.push('', 'Note: ' + i.notes);
    L.push('', 'Thanks!', S.me.name);
    var cc = S.me.admin ? [] : [dpEmail()];
    return mailto(to.map(function (c) { return c.email; }).concat(cc), S.job.title + ': ' + what, L.join('\n'));
  }

  function myUpdate() {
    var prod = production();
    var to = (S.me.admin ? [] : [dpEmail()]).concat(prod.map(function (c) { return c.email; }));
    var names = (S.me.admin ? [] : ['Elliot']).concat(prod.map(function (c) { return first(c.name); }));
    var L = ['Hey ' + (names.length ? names.join(' & ') : 'all') + ',', '', 'Quick update for ' + S.job.title + ':', ''];
    var t = myTasks(), done = t.filter(function (x) { return x.done; }), open = t.filter(function (x) { return !x.done; });
    if (done.length) { L.push('Done:'); done.forEach(function (x) { L.push('- ' + x.task); }); L.push(''); }
    var k = myItems();
    if (k.length) {
      L.push('My kit:');
      k.forEach(function (i) { L.push('- ' + i.item + (i.qty && i.qty !== '1' ? ' x' + i.qty : '') + ' (' + (!i.supplier || same(i.supplier, 'TBC') ? 'no supplier yet' : i.supplier) + (i.confirmed ? ', confirmed' : ', not confirmed') + (i.packed ? ', packed' : '') + ')'); });
      L.push('');
    }
    if (open.length) { L.push('Still to do:'); open.forEach(function (x) { L.push('- ' + x.task + (x.due ? ' (by ' + x.due + ')' : '')); }); L.push(''); }
    L.push('It\'s all on the Hymn Sheet too.', '', 'Thanks!', S.me.name);
    return mailto(to, S.job.title + ': update from ' + first(S.me.name), L.join('\n'));
  }

  function shotsView() {
    if (!S.shots.length) return '';
    return '<section><h2>Shot list <span class="grey">(' + S.shots.length + ')</span></h2><ol class="shots">' + S.shots.map(function (s) {
      return '<li><span class="no">' + esc(s.no) + '</span><div><div class="name">' + esc(s.shot) + '</div>' + (s.notes ? '<div class="meta">' + esc(s.notes) + '</div>' : '') + '</div></li>';
    }).join('') + '</ol></section>';
  }

  function logView() {
    return '<section><h2>Changes</h2><ol class="log">' + S.log.map(function (l) {
      return '<li><span class="grey">' + esc(l.time) + '</span> <span>' + esc(l.who) + '</span> <span class="grey">' + esc(l.what) + '</span></li>';
    }).join('') + '</ol></section>';
  }

  /* ---------- events ---------- */
  function findItem(id) { return S.items.filter(function (i) { return i.id === id; })[0]; }
  function stamp() { return S.me.name + ' · now'; }

  root.addEventListener('click', function (e) {
    if (e.target.closest('a')) return; // links (call, email, WhatsApp) just open
    var t = e.target.closest('[data-tab],[data-act]');
    if (!t) return;
    if (t.hasAttribute('data-tab')) { ui.tab = t.getAttribute('data-tab'); store('hymn_tab', ui.tab); ui.open = null; render(); window.scrollTo(0, 0); return; }
    var a = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    if (a === 'filter') { ui.filter = ui.filter === t.getAttribute('data-f') ? 'all' : t.getAttribute('data-f'); ui.tab = 'kit'; render(); return; }
    if (a === 'openitem') { ui.open = ui.open === id ? null : id; render(); return; }
    if (a === 'adding') { ui.adding = !ui.adding; render(); var f = document.getElementById('add_item'); if (f) f.focus(); return; }
    if (a === 'editnotes') { ui.editNotes = !ui.editNotes; render(); return; }
    if (a === 'allflags') { ui.allFlags = !ui.allFlags; render(); return; }
    if (a === 'editjob') { ui.editJob = !ui.editJob; render(); return; }
    if (a === 'addcrew') { ui.addCrew = !ui.addCrew; render(); return; }
    if (a === 'crewopen') { var n = +t.getAttribute('data-n'); ui.crewOpen = ui.crewOpen === n ? null : n; render(); return; }
    if (a === 'copy') { copy(t.getAttribute('data-text')); t.textContent = 'Copied'; return; }
    if (a === 'pack' || a === 'confirm') {
      var field = a === 'pack' ? 'packed' : 'confirmed';
      send({ a: 'tick_item', id: id, field: field }, function () { var i = findItem(id); i[field] = i[field] ? '' : stamp(); });
      return;
    }
    if (a === 'delitem') { send({ a: 'delete_item', id: id }, function () { S.items = S.items.filter(function (i) { return i.id !== id; }); ui.open = null; }); return; }
    if (a === 'task') { send({ a: 'tick_task', id: id }, function () { var k = S.tasks.filter(function (x) { return x.id === id; })[0]; k.done = k.done ? '' : stamp(); }); return; }
    if (a === 'deltask') { send({ a: 'delete_task', id: id }, function () { S.tasks = S.tasks.filter(function (x) { return x.id !== id; }); }); return; }
    if (a === 'kitdone') { send({ a: 'kit_done' }, function () { var c = S.crew.filter(function (x) { return same(x.name, S.me.name); })[0]; if (c) c.kit_done = c.kit_done ? '' : 'now'; }); return; }
    if (a === 'flag') { send({ a: 'resolve_flag', id: id }, function () { var f = S.flags.filter(function (x) { return x.id === id; })[0]; if (f) f.status = 'sorted'; }); return; }
  });

  root.addEventListener('change', function (e) {
    var sel = e.target;
    if (sel.tagName === 'SELECT' && sel.getAttribute('data-other')) {
      var other = document.getElementById(sel.getAttribute('data-other'));
      if (other) { other.classList.toggle('hide', sel.value !== '__other'); if (sel.value === '__other') other.focus(); }
    }
  });

  root.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, kind = f.getAttribute('data-form');
    var v = {};
    Array.prototype.forEach.call(f.elements, function (el) { if (el.name) v[el.name] = el.value.trim(); });
    if (v.supplier === '__other') v.supplier = v.supplier_other || 'TBC';
    delete v.supplier_other;
    function clear() { Array.prototype.forEach.call(f.querySelectorAll('[data-keep]'), function (el) { if (el.tagName === 'INPUT') el.value = ''; }); }

    if (kind === 'add') {
      if (!v.item) return;
      var tmp = { id: 'tmp' + Date.now(), item: v.item, qty: v.qty, dept: v.dept, supplier: v.supplier || 'TBC', asked_by: S.me.name, owner: S.me.name, notes: v.notes, confirmed: '', packed: '' };
      clear(); ui.adding = false;
      send({ a: 'add_item', item: v.item, qty: v.qty, dept: v.dept, supplier: v.supplier, notes: v.notes, confirm: S.me.admin ? 1 : 0 }, function () { if (S.me.admin) tmp.confirmed = stamp(); S.items.push(tmp); });
    } else if (kind === 'item') {
      var id = f.getAttribute('data-id');
      ui.open = null;
      send({ a: 'set_item', id: id, fields: v }, function () { var i = findItem(id); Object.keys(v).forEach(function (k) { i[k] = v[k]; }); });
    } else if (kind === 'flag') {
      if (!v.text) return;
      clear();
      send({ a: 'raise_flag', text: v.text }, function () { S.flags.push({ id: 'tmp', text: v.text, status: 'open', raised_by: S.me.name, time: 'now' }); });
    } else if (kind === 'task') {
      if (!v.task) return;
      clear();
      send({ a: 'add_task', who: v.who, task: v.task, due: v.due }, function () { S.tasks.push({ id: 'tmp' + Date.now(), who: v.who, task: v.task, due: v.due, done: '' }); });
    } else if (kind === 'crew') {
      if (!v.name) return;
      clear(); ui.addCrew = false;
      send({ a: 'add_crew', name: v.name, role: v.role, email: v.email, phone: v.phone, dept: v.dept });
    } else if (kind === 'notes') {
      ui.editNotes = false;
      var txt = f.querySelector('textarea').value;
      send({ a: 'set_job', fields: { dp_notes: txt } }, function () { S.job.dp_notes = txt; });
    } else if (kind === 'job') {
      ui.editJob = false;
      send({ a: 'set_job', fields: v }, function () { Object.keys(v).forEach(function (k) { S.job[k] = v[k]; }); });
    }
  });

  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () { prompt('Copy this link', text); });
    else prompt('Copy this link', text);
  }

  /* ---------- polling ---------- */
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { if (!document.hidden) refresh().then(schedule, schedule); else schedule(); }, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  window.addEventListener('online', function () { refresh(); });

  /* ---------- start ---------- */
  if (!API) { fatal('Not switched on yet. Elliot needs to paste the script link into config.js.'); return; }
  if (!key) { fatal('Open the link Elliot sent you. Each person has their own.'); return; }
  if (S) render();
  refresh().then(schedule, schedule);
})();

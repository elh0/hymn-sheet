/* Hymn Sheet: one live page per job that the whole crew works from. */
(function () {
  'use strict';

  var API = window.HYMN_API || '';
  var POLL_MS = 8000;
  var DEPTS = ['Camera', 'Focus', 'Video', 'Grip', 'Lighting', 'DIT', 'Director', 'On the day', 'Other'];
  var SUPPLIERS = ['TBC', 'Rental house', 'Production', 'Own kit', 'Elliot'];

  var params = new URLSearchParams(location.search);
  // A person's forever link is crew.elliot.onl/milo-k7f3x2a9; older links use ?k=.
  var PERSON = /^[a-z0-9]+-[a-z0-9]{8}$/;
  var pathKey = (location.pathname.split('/').pop() || '');
  var key = params.get('k') || (PERSON.test(pathKey) ? pathKey : '') || store('hymn_key') || '';
  if (key) store('hymn_key', key);
  var job = params.get('j') || store('hymn_job_' + key) || '';   // which of their jobs is open

  var S = load('hymn_state_' + key + '_' + job) || load('hymn_state_' + key);   // last state from the server
  var queue = load('hymn_queue_' + key) || [];
  var ui = { tab: store('hymn_tab2') || 'mine', filter: 'all', open: null, adding: false, editJob: false, addCrew: false, crewOpen: null };
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
  // On crew.elliot.onl links read crew.elliot.onl/<job>?k=KEY (404.html serves the app for any path).
  var NICE = location.hostname === 'crew.elliot.onl';
  function linkFor(k) {
    if (PERSON.test(k)) return (NICE ? location.origin : 'https://crew.elliot.onl') + '/' + k;
    if (NICE && S && S.job && S.job.job) return location.origin + '/' + encodeURIComponent(S.job.job) + '?k=' + encodeURIComponent(k);
    return location.origin + location.pathname + '?k=' + encodeURIComponent(k);
  }
  function tidyUrl() {
    if (!NICE || !S || !S.job || !S.job.job || !key) return;
    var want = PERSON.test(key) ? '/' + key : '/' + encodeURIComponent(S.job.job) + '?k=' + encodeURIComponent(key);
    if (location.pathname + location.search !== want) try { history.replaceState(null, '', want); } catch (e) {}
  }

  /* ---------- since you last looked ---------- */
  // The log's times read "24 Nov 20:18" (London). Changes by others after the
  // last visit on this phone are listed at the top and marked in the log & kit.
  var MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  function whenOf(t) {
    var m = /^(\d{1,2}) (\w{3}) (\d{1,2}):(\d{2})/.exec(String(t || ''));
    if (!m || MON[m[2]] === undefined) return 0;
    var now = new Date(), d = new Date(now.getFullYear(), MON[m[2]], +m[1], +m[3], +m[4]);
    if (d - now > 864e5) d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  }
  var seenKey = 'hymn_seen_' + key;
  var lastLook = Number(store(seenKey)) || 0, hiddenAt = 0;
  function markSeen() { store(seenKey, String(Date.now())); }
  function fresh() {
    if (!lastLook || !S || !S.log) return [];
    return S.log.filter(function (l) { return !same(l.who, S.me.name) && whenOf(l.time) > lastLook - 60000; });
  }
  function isFreshItem(i) {
    return fresh().some(function (l) { return String(l.what).indexOf(i.item) >= 0; });
  }
  function sinceBlock() {
    var f = fresh();
    if (!f.length || ui.dismissed) return '';
    var h = '<section class="since"><h2>Since you last looked <span class="grey">' + f.length + ' change' + (f.length > 1 ? 's' : '') + '</span></h2><ul>';
    f.slice(0, 6).forEach(function (l) {
      h += '<li><span>' + esc(first(l.who)) + '</span> <span class="grey">' + esc(l.what) + '</span></li>';
    });
    h += '</ul><div class="row">';
    if (f.length > 6) h += '<button class="link" data-act="tab" data-t="log">See all ' + f.length + '</button>';
    h += '<button class="link" data-act="gotit">Got it</button></div></section>';
    return h;
  }

  /* ---------- questions ---------- */
  function asks() { return (S && S.asks) || []; }
  function forMe(q) { return same(q.to, S.me.name) || (same(q.to, 'Everyone') && !same(q.from, S.me.name)) || (S.me.admin && same(q.to, 'Elliot')); }
  function fromMe(q) { return same(q.from, S.me.name); }
  function askSeen() { return load('hymn_asks_' + key) || []; }
  function openForMe() { return asks().filter(function (q) { return !q.answer && forMe(q); }); }
  function newAnswers() { var s = askSeen(); return asks().filter(function (q) { return q.answer && fromMe(q) && s.indexOf(q.id) < 0; }); }
  function askRow(q, reply) {
    var h = '<li class="ask-q"><div class="name">' + (q.about ? '<span class="grey">' + esc(q.about) + ': </span>' : '') + esc(q.text) + '</div>';
    h += '<div class="meta">' + esc(first(q.from)) + ' → ' + esc(q.to) + (q.asked ? ' · ' + esc(q.asked) : '') + '</div>';
    if (q.answer) h += '<div class="answer">' + esc(q.answer) + ' <span class="grey">' + esc(first(q.answered_by)) + (q.answered ? ', ' + esc(q.answered) : '') + '</span></div>';
    else if (reply) h += '<form class="reply" data-form="answer" data-id="' + esc(q.id) + '"><input name="text" id="ans_' + esc(q.id) + '" data-keep="ans_' + esc(q.id) + '" placeholder="Your answer"><button type="submit">Reply</button></form>';
    return h + '</li>';
  }
  // Pinned at the top of every tab: questions waiting on you, & answers to yours.
  function asksBlock() {
    var o = openForMe(), n = newAnswers();
    if (!o.length && !n.length) return '';
    var h = '<section class="asks">';
    if (o.length) h += '<h2>' + (o.length > 1 ? o.length + ' questions' : 'A question') + ' for you</h2><ul>' + o.map(function (q) { return askRow(q, true); }).join('') + '</ul>';
    if (n.length) {
      h += '<h2>' + (n.length > 1 ? 'Answers' : 'An answer') + ' to your question' + (n.length > 1 ? 's' : '') + '</h2><ul>' + n.map(function (q) { return askRow(q); }).join('') + '</ul>';
      h += '<div class="row"><button class="link" data-act="seenanswers">Got it</button></div>';
    }
    return h + '</section>';
  }
  function askForm() {
    var h = '<section id="askform"><h2>Ask someone</h2><form class="box" data-form="ask">';
    h += '<label>Who<select name="to" data-keep="ask_to">' + askOptions() + '</select></label>';
    if (ui.askAbout) h += '<p class="grey small">About: ' + esc(ui.askAbout) + ' <button type="button" class="link" data-act="askclear">×</button></p>';
    h += '<label>Question<input name="text" id="ask_text" data-keep="ask_text" placeholder="e.g. Is the Rialto on the quote?"></label>';
    h += '<div class="row"><button type="submit">Ask</button></div></form><p class="grey small">They\'ll see it at the top when they open their link.</p></section>';
    return h;
  }
  function askOptions() {
    var names = S.crew.map(function (c) { return c.name; }).concat(S.me.admin ? [] : ['Elliot']).filter(function (n) { return !same(n, S.me.name); }).concat(['Everyone']);
    var cur = ui.askTo || (S.me.admin ? '' : 'Elliot');
    return names.map(function (n) { return '<option' + (same(n, cur) ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
  }
  function asksList() {
    var mine = asks().filter(function (q) { return S.me.admin || forMe(q) || fromMe(q); });
    if (!mine.length) return '';
    var open = mine.filter(function (q) { return !q.answer; }), done = mine.filter(function (q) { return q.answer; });
    var h = '<section><h2>Questions <span class="grey">(' + open.length + ' open)</span></h2><ul>';
    open.concat(done.reverse()).forEach(function (q) {
      h += askRow(q, forMe(q) || S.me.admin).replace('</li>', (S.me.admin || fromMe(q) ? '<button class="link grey small" data-act="delask" data-id="' + esc(q.id) + '">Remove</button>' : '') + '</li>');
    });
    return h + '</ul></section>';
  }

  /* ---------- server ---------- */
  function get() {
    return fetch(API + '?a=state&k=' + encodeURIComponent(key) + (job ? '&job=' + encodeURIComponent(job) : ''), { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function post(op) {
    var body = JSON.stringify(Object.assign({ job: job }, op, { k: key }));
    return fetch(API, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } })
      .then(function (r) { return r.json(); });
  }

  var prefetched = false;
  function prefetch() {
    if (prefetched || !S || !S.me || !S.me.admin || !S.jobs || S.jobs.length < 2) return;
    prefetched = true;
    S.jobs.forEach(function (x, n) {
      if (x.job === job) return;
      setTimeout(function () {
        fetch(API + '?a=state&k=' + encodeURIComponent(key) + '&job=' + encodeURIComponent(x.job), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d && !d.error && d.job && d.job.job === x.job) save('hymn_state_' + key + '_' + x.job, d); })
          .catch(function () {});
      }, 1500 * (n + 1));
    });
  }

  function took(data) {
    if (data && data.error) { status = { text: data.error, bad: true }; return false; }
    // An answer for a job they've since switched away from: keep it for later, don't show it.
    if (job && data && data.job && data.job.job !== job && data.jobs && data.jobs.some(function (x) { return x.job === job; })) {
      save('hymn_state_' + key + '_' + data.job.job, data); return true;
    }
    S = data; lastOk = Date.now();
    if (S.job && S.job.job) { job = S.job.job; store('hymn_job_' + key, job); }
    save('hymn_state_' + key + '_' + job, S); tidyUrl();
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
    var asked = job;
    return get().then(function (d) {
      if (d && d.error && !S) { fatal(d.error); return; }
      if (asked !== job) return;   // switched job while this was loading
      took(d);
      prefetch();
      if (typing()) paintStatus(); else render();
    }).catch(function () { offline(); });
  }

  // Changes go into a queue first, so ticks made with no signal are sent later.
  // rules.js turns the change into a plain Sheet op (before the screen updates,
  // so it sees what was there); the backend only checks keys.
  var PIPE = { add: 1, set: 1, del: 1, batch: 1 };
  // Until the new script is deployed (state has no v), send the old-style action.
  function toPipe(op) { if (S && !S.v) return op; return PIPE[op.a] ? op : window.HymnRules.translate(op, S || {}); }
  function send(op, optimistic) {
    op = toPipe(op);
    if (op && !op.error && job) op.job = job;
    if (!op || op.error) { status = op ? { text: op.error, bad: true } : { text: '', bad: false }; paintStatus(); render(); return Promise.resolve(); }
    queue.push(op); save('hymn_queue_' + key, queue);
    if (optimistic) { try { optimistic(); } catch (e) {} }
    render();
    return flush();
  }

  function flush() {
    if (busy || !queue.length) return Promise.resolve();
    busy = true; status = { text: 'Saving…', bad: false }; paintStatus();
    var out = toPipe(queue[0]);   // older phones may have queued un-translated changes
    if (!out || out.error) { queue.shift(); save('hymn_queue_' + key, queue); busy = false; if (queue.length) return flush(); return refresh(); }
    return post(out).then(function (d) {
      queue.shift(); save('hymn_queue_' + key, queue);
      busy = false;
      var ok = took(d);
      if (!ok) { var msg = status.text; get().then(function (x) { took(x); status = { text: msg, bad: true }; render(); }); }
      render();
      if (queue.length) return flush();
    }).catch(function () { busy = false; offline(); });
  }

  function offline() {
    if (!S) { fatal('Can\'t reach the Hymn Sheet right now. Check your signal, then reload the page.'); return; }
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
    needs().forEach(function (r) {
      if (!bookedAs(r)) out.push({ text: 'No ' + r + ' booked yet. ' + bookers() + ' to book one?', auto: 'need', role: r });
    });
    if (S.me.admin) (S.bookings || []).forEach(function (b) {
      out.push({ text: first(b.by) + ' booked ' + b.name + ' as ' + b.role + '. They need a link.', auto: 'booking', id: b.id });
    });
    var roleless = {};
    S.items.concat(S.tasks).forEach(function (i) { var w = i.owner || i.who; if (isUnnamed(w)) (roleless[w] = roleless[w] || []).push(i.item || i.task); });
    Object.keys(roleless).forEach(function (w) {
      var l = roleless[w], got = bookedAs(w.replace(UNNAMED, ''));
      if (got) { out.push({ text: first(got.name) + ' is booked as ' + (got.role || 'crew').toLowerCase() + ' now. Put their name on: ' + l.slice(0, 3).join(', ') + (l.length > 3 ? '…' : ''), auto: 'unnamed' }); return; }
      out.push({ text: w.replace(UNNAMED, '') + ' not booked yet, so nobody\'s bringing: ' + l.slice(0, 3).join(', ') + (l.length > 3 ? '…' : '') + '. ' + bookers() + ' to book one?', auto: 'unnamed' });
    });
    var unc = S.items.filter(function (i) { return !i.confirmed; });
    if (unc.length) out.push({ text: unc.length + ' item' + (unc.length > 1 ? 's' : '') + ' not confirmed yet', auto: 'unconfirmed' });
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
    try { draw(); }
    catch (e) {
      // A saved copy from an older version can trip the page up: drop it and fetch fresh.
      store('hymn_state_' + key + '_' + job, null); store('hymn_state_' + key, null);
      fatal('Something went wrong showing this page (' + (e && e.message) + '). Reload to try again.');
    }
  }
  function draw() {
    if (!S) return;
    var active = document.activeElement;
    var keepId = active && active.id, keepVal = active && active.value, keepPos = active && active.selectionStart;
    var forms = {};
    Array.prototype.forEach.call(root.querySelectorAll('[data-keep]'), function (el) { forms[el.getAttribute('data-keep')] = el.value; });

    var h = '<div class="wrap">' + header() + tabs() + '<main>';
    if (S.loading) h += '<p class="grey gap">Loading…</p>';
    else h += hint();
    if (!S.loading && ui.tab !== 'log' && ui.tab !== 'chat') h += asksBlock() + sinceBlock();
    if (S.loading) {}
    else if (ui.tab === 'kit') h += kitView();
    else if (ui.tab === 'mine') h += mineView();
    else if (ui.tab === 'chat') h += chatView();
    else if (ui.tab === 'crew') h += crewView();
    else if (ui.tab === 'notes' || ui.tab === 'shots') h += notesView() + shotsView();
    else h += logView();
    h += '</main><footer>Elliot Holbrow · DP · <button class="link grey" data-act="tour">How it works</button></footer></div>' + sureBar() + '<div id="status"></div>';
    root.innerHTML = h;

    Object.keys(forms).forEach(function (k) { var el = root.querySelector('[data-keep="' + k + '"]'); if (el) el.value = forms[k]; });
    if (keepId) {
      var el = document.getElementById(keepId);
      if (el) { el.focus(); if (keepVal !== undefined && el.value !== keepVal && el.tagName !== 'SELECT') el.value = keepVal; try { el.setSelectionRange(keepPos, keepPos); } catch (e) {} }
    }
    // Chat: read once you're looking at it; jump to the newest when you open it or something new arrives.
    if (ui.tab === 'chat' && !S.loading) {
      var cn = ((S && S.chat) || []).length;
      if (ui.chatScroll || ui.chatLen !== cn || ui.lastTab !== 'chat') window.scrollTo(0, document.body.scrollHeight);
      ui.chatLen = cn; ui.chatScroll = false; markChatSeen();
    }
    ui.lastTab = ui.tab;
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
    if (S.jobs && S.jobs.length > 1) {
      h += '<div class="jobs">' + S.jobs.map(function (x) {
        return '<button class="' + (x.job === j.job ? 'on' : '') + '" data-act="job" data-job="' + esc(x.job) + '">' + esc(x.title || x.job) + '</button>';
      }).join('') + '</div>';
    }
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
        [['title', 'Title'], ['dates', 'Shoot'], ['call', 'Call'], ['location', 'Where'], ['prep', 'Prep'], ['notes', 'Note'], ['deck', 'Deck link'], ['needs', 'Crew needed']].forEach(function (f) {
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
    var t = [['mine', 'Me'], ['kit', 'Kit'], ['notes', 'Plan'], ['chat', 'Chat'], ['crew', 'Crew'], ['log', 'Changes']];
    return '<nav>' + t.map(function (x) {
      var extra = '';
      if (x[0] === 'mine') { var open = myTasks().filter(function (k) { return !k.done; }).length + myFlags().length + toSend().length + myChainSteps().length; if (open) extra = ' (' + open + ')'; }
      if (x[0] === 'chat' && ui.tab !== 'chat') { var un = chatUnread(); if (un) extra = ' <span class="blue">(' + un + ')</span>'; }
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
      if (x.auto === 'unconfirmed') h += '<button class="link" data-act="filter" data-f="unconfirmed">Show</button>';
      if (x.auto === 'nosupplier') h += '<button class="link" data-act="filter" data-f="nosupplier">Show</button>';
      if (x.auto === 'need' && canBook()) h += '<button class="link" data-act="booknow" data-role="' + esc(x.role) + '">Add name</button>';
      if (x.auto === 'booking') h += '<button class="link" data-act="givebooking" data-id="' + esc(x.id) + '">Give them a link</button>';
      h += '</li>';
    });
    if (all > 3) h += '<li><button class="link" data-act="allflags">' + (ui.allFlags ? 'Show fewer' : 'Show all ' + all) + '</button></li>';
    h += '</ol>';
    if (ui.booking) {
      h += '<form class="box book" data-form="booking"><h2>Who\'s the ' + esc(ui.booking) + '?</h2><input type="hidden" name="role" value="' + esc(ui.booking) + '">';
      [['name', 'Name'], ['phone', 'Phone'], ['email', 'Email']].forEach(function (f) {
        h += '<label>' + f[1] + '<input name="' + f[0] + '" id="book_' + f[0] + '" data-keep="book_' + f[0] + '"' + (f[0] === 'email' ? ' type="email"' : f[0] === 'phone' ? ' type="tel"' : '') + '></label>';
      });
      h += '<div class="row"><button type="submit">Add to crew</button><button type="button" class="link" data-act="booknow">Cancel</button></div>';
      h += '<p class="grey small">' + (S.me.admin ? 'They go straight on the crew with their own link.' : 'Elliot sends them their link.') + '</p></form>';
    }
    return h + '</section>';
  }

  function kitView() {
    var h = chainBlock() + flagsBlock();
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
      h += '<section id="dept-' + esc(String(d).toLowerCase()) + '"><h2>' + esc(d) + ' <span class="grey">(' + groups[d].length + ')</span></h2><ul class="items">';
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
    if (isFreshItem(i)) meta.push(tag('t-blue new', 'new'));
    meta.push(!i.supplier || same(i.supplier, 'TBC') ? tag('t-red red', 'no supplier') : tag('t-blue', esc(i.supplier)));
    if (i.owner && !same(i.owner, i.asked_by)) meta.push(tag('t-plain', 'with ' + esc(first(i.owner))));
    if (i.asked_by) meta.push(tag('t-plain', 'asked ' + esc(first(i.asked_by))));
    meta.push(i.confirmed ? tag('t-green', 'confirmed') : tag('t-yellow amber', 'not confirmed'));
    if (i.packed) meta.push(tag('t-grey', 'packed ' + esc(first(i.packed.split(' · ')[0]))));
    h += '<div class="meta">' + meta.join('<span class="sep"> · </span>') + '</div>';
    if (i.notes && !open) h += '<div class="meta note">' + esc(i.notes) + '</div>';
    h += '</div>';
    h += '<button class="tick' + (i.confirmed ? ' on' : '') + '" data-act="confirm" data-id="' + esc(i.id) + '">' + (i.confirmed ? 'OK' : 'Confirm') + '</button>';
    h += '</li>';
    if (open) h += itemEditor(i);
    return h;
  }

  function supplierOptions(cur) {
    var list = SUPPLIERS.slice();
    if (cur && list.indexOf(cur) < 0) list.splice(1, 0, cur);
    return list.map(function (s) { return '<option' + (s === cur ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '<option value="__other">Other…</option>';
  }
  // Roles that can be picked before anyone's booked: "Grip (not named yet)". They raise a flag until a name goes in.
  // Who books crew & kit: producer, production manager / PM, coordinator. Not "production designer" (that's art).
  var BOOKER = /producer|production manager|coordinator|\bpm\b/i;
  var OPEN_ROLES = ['Grip', 'Gaffer', 'Spark', '1st AC', '2nd AC', 'DIT', 'Steadicam op', 'Playback', 'Production', 'Art dept'];
  var UNNAMED = ' (not named yet)';
  var ROLE_MATCH = { 'Grip': /grip/i, 'Gaffer': /gaffer/i, 'Spark': /spark|electric/i, '1st AC': /1st ac|focus/i, '2nd AC': /2nd ac|clapper|loader/i,
    'DIT': /\bdit\b|data/i, 'Steadicam op': /steadicam|operator|handheld/i, 'Playback': /playback|vtr|video/i, 'Production': BOOKER, 'Art dept': /\bart\b|designer|props/i };
  function isUnnamed(n) { return String(n || '').indexOf(UNNAMED) > 0; }
  // Someone on the crew already does this role (Mark, Gaffer).
  function roleRe(role) { return ROLE_MATCH[role] || new RegExp(String(role).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  function bookedAs(role) {
    var re = roleRe(role);
    return S.crew.filter(function (c) { return re.test(c.role || ''); })[0] ||
      (S.bookings || []).filter(function (b) { return re.test(b.role || ''); }).map(function (b) { return { name: b.name, role: b.role, pending: true }; })[0] || null;
  }
  function needs() { return String((S.job && S.job.needs) || '').split(/\s*,\s*/).filter(Boolean); }
  function canBook() { return S.me.admin || BOOKER.test(S.me.role || ''); }
  function bookers() { var b = S.crew.filter(function (c) { return BOOKER.test(c.role || ''); }).map(function (c) { return first(c.name); }); return b.length ? b.join(' or ') : 'Production'; }
  function crewOptions(cur) {
    var names = S.crew.map(function (c) { return c.name; }).concat(['Elliot']);
    var roles = OPEN_ROLES.filter(function (r) { return !bookedAs(r); }).map(function (r) { return r + UNNAMED; });
    if (cur && names.indexOf(cur) < 0 && roles.indexOf(cur) < 0) names.unshift(cur);
    if (!roles.length) return names.map(opt).join('');
    function opt(n) { return '<option' + (same(n, cur) ? ' selected' : '') + '>' + esc(n) + '</option>'; }
    return names.map(opt).join('') + '<optgroup label="Not booked yet">' + roles.map(opt).join('') + '</optgroup>';
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
    h += '<button type="button" class="ask" data-act="askitem" data-id="' + esc(i.id) + '">Ask about this</button>';
    h += '<a class="btn email-sup" target="_blank" rel="noopener" href="' + esc(askAbout(i)) + '">Email supplier</a>';
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

  // Elliot only: replies he still has to send (dp_send list, never served to crew). Copy, open in WhatsApp or the Gmail draft, then tick Sent.
  function toSend() { return S.me.admin ? (S.dp_send || []).filter(function (m) { return !m.sent && m.text; }) : []; }
  function msgPhone(m) {
    if (m.phone) return m.phone;
    var c = S.crew.filter(function (x) { return same(x.name, m.to) || same(first(x.name), m.to); })[0];
    return c && c.phone || '';
  }
  function toSendBlock() {
    var list = toSend();
    if (!list.length) return '';
    var h = '<section class="tosend"><h2>To send <span class="grey">(' + list.length + ')</span></h2><p class="grey small">Only you see this. Copy, send it yourself, then tap Sent.</p><ul class="items">';
    list.forEach(function (m) {
      var email = /mail/i.test(m.via || '');
      var num = msgPhone(m).replace(/[^\d]/g, '').replace(/^0/, '44');
      h += '<li class="item msg"><div class="body">';
      h += '<div class="name">' + esc(m.to) + (m.about ? ' <span class="grey">· ' + esc(m.about) + '</span>' : '') + '</div>';
      h += '<div class="meta">' + (email ? 'Email' : 'WhatsApp') + (m.why ? ' · ' + esc(m.why) : '') + '</div>';
      h += '<pre class="msgtext">' + esc(m.text) + '</pre>';
      h += '<div class="row"><button class="link" data-act="copy" data-text="' + esc(m.text) + '">Copy</button>';
      if (!email) h += '<a class="link" target="_blank" rel="noopener" href="https://wa.me/' + num + '?text=' + encodeURIComponent(m.text) + '">WhatsApp</a>';
      if (m.gmail) h += '<a class="link" target="_blank" rel="noopener" href="' + esc(m.gmail) + '">Gmail draft</a>';
      h += '<button class="link grey" data-act="msgsent" data-id="' + esc(m.id) + '">Sent</button></div>';
      h += '</div></li>';
    });
    return h + '</ul></section>';
  }

  // One line under the tabs so crew know what each one is for.
  var HINTS = {
    mine: 'Your own page: the DP notes, what you need to do, your part of the plan & your kit. Tap a button to jump to it.',
    kit: 'Every bit of kit for the shoot, by department. Tap an item to see who brings it & tick it when it\'s packed.',
    notes: 'The plan from Elliot: documents, schedule, camera, light & look. Tap a heading below to jump to it.',
    shots: 'The plan from Elliot: documents, schedule, camera, light & look. Tap a heading below to jump to it.',
    chat: 'One chat for everyone on the job. Type @ & a name to point it at someone. Tap Make it a task to put it on their list.',
    crew: 'Who\'s on the job & how to reach them.',
    log: 'Everything that\'s changed on this sheet, newest first.'
  };
  function hint() { return HINTS[ui.tab] ? '<p class="hint grey small">' + esc(HINTS[ui.tab]) + '</p>' : ''; }

  // The "## Documents" lines from the notes, so everyone starts from the same files.
  function docLines() {
    var d = sections().filter(function (x) { return /^documents/i.test(x.title); })[0];
    return d ? d.lines.map(function (l) { var b = l.match(/^\s*[-•]\s+(.*)/); return b ? b[1] : l.trim(); }).filter(Boolean) : [];
  }
  function docsBlock() {
    var d = docLines();
    if (!d.length) return '';
    return '<section class="docs" id="docs"><h2>All documents</h2><ul class="doclist">' + d.map(function (l) { return '<li>' + linkify(l) + '</li>'; }).join('') + '</ul></section>';
  }

  // Which flags land on whose page, by what the flag is about. A flag can also name people in its "to" column.
  var FLAG_WORDS = {
    steadicam: ['steadicam', 'handheld', 'hand held', 'backpack', 'walk'],
    // Camera kit a Steadicam op should know about (weight, lenses, focus), without the codecs & drives.
    rig: ['lens', 'prime', 'zoom', 'rialto', 'ember', 'filter', 'focus', 'ff4', 'ff5', 'zmu', 'alura', 'optimo'],
    Camera: ['camera', 'lens', 'prime', 'zoom', 'venice', 'rialto', 'ember', 'filter', 'focus', 'ff4', 'ff5', 'zmu', 'codec', 'sticks', 's35', 'alura', 'optimo', 'scoopic', 'monitor'],
    Focus: ['camera', 'lens', 'prime', 'zoom', 'venice', 'rialto', 'ember', 'filter', 'focus', 'ff4', 'ff5', 'zmu', 'codec', 'sticks', 's35', 'alura', 'optimo', 'scoopic', 'monitor'],
    Lighting: ['light', 'lamp', 'gaffer', 'genny', 'power', 'hmi', '18k', '9k', '5k', 'fresnel', 'brute', 'lightstar', 'sunrise'],
    Grip: ['jib', 'dolly', 'track', 'grip', 'slider', 'crane', 'rickshaw', 'sunrise'],
    DIT: ['codec', 'drive', 'dit', 'lut', 'data', 'filmbox', 'dehancer', 'monitor'],
    Video: ['monitor', 'playback', 'teradek', 'video']
  };
  function hasWord(t, words) { t = ' ' + t.toLowerCase() + ' '; return words.some(function (w) { return new RegExp('[^a-z0-9]' + w.replace(/\s/g, '\\s') + '[^a-z]').test(t); }); }
  function sheetFlags() { return (S.flags || []).filter(function (f) { return f.status !== 'sorted'; }); }
  // Steadicam ops get Steadicam flags as theirs & other camera flags to think about; everyone else gets their department's.
  function flagWordsFor(c) {
    var role = String(c.role || '').toLowerCase();
    if (/steadicam|handheld/.test(role)) return { main: FLAG_WORDS.steadicam, think: FLAG_WORDS.rig };
    return { main: FLAG_WORDS[c.dept] || [], think: [] };
  }
  // Open flags that are about you: they name you, you raised them, they're about your kit or your department. Elliot sees them all.
  function myFlags() {
    var open = sheetFlags();
    if (S.me.admin) return open;
    var meRow = S.crew.filter(function (c) { return same(c.name, S.me.name); })[0] || {};
    var re = nameRe(S.me.name);
    var kit = myItems().map(function (i) { return String(i.item).toLowerCase(); });
    var words = flagWordsFor(meRow).main;
    return open.filter(function (f) {
      var t = String(f.text || '');
      if (f.to) return re && re.test(f.to);
      if (re && (re.test(t) || re.test(f.raised_by || ''))) return true;
      if (namesSomeone(t)) return false; // it names someone else: theirs, not the whole department's
      return kit.some(function (k) { return k.length > 3 && t.toLowerCase().indexOf(k) >= 0; }) || (words.length && hasWord(t, words));
    });
  }
  // How a flag names someone: their first name, or their full name when two crew share a first name (Jack & Jack).
  function nameRe(name) {
    var f = first(name).replace(/[^\w]/g, '');
    if (f.length < 2) return null;
    var shared = S.crew.filter(function (c) { return same(first(c.name), f); }).length > 1;
    var w = shared ? String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : f;
    return new RegExp('\\b' + w + '\\b', 'i');
  }
  function namesSomeone(t) {
    return S.crew.some(function (c) { var r = first(c.name).length > 2 && nameRe(c.name); return r && r.test(t); });
  }
  // Flags near your job that aren't yours to sort, just worth a think (e.g. camera flags for the Steadicam op).
  function thinkFlags() {
    if (S.me.admin) return [];
    var meRow = S.crew.filter(function (c) { return same(c.name, S.me.name); })[0] || {};
    var w = flagWordsFor(meRow).think, mine = myFlags();
    if (!w.length) return [];
    return sheetFlags().filter(function (f) { return mine.indexOf(f) < 0 && !f.to && hasWord(String(f.text || ''), w); });
  }
  function flagRow(f) {
    var h = '<li class="item flagrow"><span class="flagmark red">!</span><div class="body"><div class="name">' + esc(f.text) + '</div>';
    h += '<div class="meta">Flag' + (f.raised_by || f.source ? ' · ' + esc(f.raised_by || f.source) : '') + (f.time ? ', ' + esc(f.time) : '') + '</div></div>';
    if (S.me.admin) h += '<button class="link" data-act="flag" data-id="' + esc(f.id) + '">Sorted</button>';
    return h + '</li>';
  }

  /* ---------- kit lists: five steps each, one line per list ---------- */
  var STEPS = [
    ['listed', 'Listed', 'Mark it listed', 'for the list'],
    ['ok', 'DP OK', 'OK it', 'to OK the list'],
    ['confirmed', 'Confirmed', 'Confirm it', 'to confirm it'],
    ['prepped', 'Prepped', 'Mark prepped', 'to prep it'],
    ['onset', 'On set', 'Mark on set', 'to bring it to set']];
  function chains() { return (S && S.chain) || []; }
  function booker() {
    var b = S.crew.filter(function (c) { return /production manager|\bpm\b/i.test(c.role || ''); })[0] || S.crew.filter(function (c) { return BOOKER.test(c.role || ''); })[0];
    return b ? b.name : 'Production';
  }
  function stepOwner(c, k) { return k === 'listed' ? c.lister : k === 'ok' ? 'Elliot' : k === 'confirmed' ? booker() : c.preps; }
  function canStep(c, k) { return S.me.admin || (k === 'confirmed' ? BOOKER.test(S.me.role || '') : same(stepOwner(c, k), S.me.name)); }
  function nextStep(c) { for (var n = 0; n < STEPS.length; n++) if (!c[STEPS[n][0]]) return n; return -1; }
  function shortStamp(v) { var p = String(v || '').split(' · '); return p.length > 1 ? first(p[0]) + ' ' + p[1] : v; }
  function chainRow(c) {
    var n = nextStep(c), open = ui.openChain === c.id, h = '<div class="chain-row' + (open ? ' open' : '') + '">';
    var st = n >= 0 ? STEPS[n] : null, who = st ? stepOwner(c, st[0]) : '';
    h += '<div class="top" data-act="chainopen" data-id="' + esc(c.id) + '"><b>' + esc(c.list) + '</b>';
    if (st && canStep(c, st[0])) h += '<button class="pillbtn go" data-act="chainstep" data-id="' + esc(c.id) + '" data-step="' + st[0] + '">' + esc(st[2]) + '</button>';
    else if (st && who) h += '<button class="pillbtn" data-act="chainremind" data-id="' + esc(c.id) + '">Remind</button>';
    h += '</div><div class="bar" data-act="chainopen" data-id="' + esc(c.id) + '">' + STEPS.map(function (x, i) { return '<i class="' + (c[x[0]] ? 'd' : i === n ? 'n' : '') + '"></i>'; }).join('') + '</div>';
    if (st) h += '<div class="next">Waiting on <span class="who">' + esc(same(who, S.me.name) ? 'you' : first(who) || '?') + '</span> ' + esc(st[3]) + (c.due && n === 0 ? ', by ' + esc(c.due) : '') + '</div>';
    else h += '<div class="next done">All done</div>';
    if (!open) {
      var rest = STEPS.map(function (x, i) { return c[x[0]] ? x[1] + ' ✓' : i > n ? first(stepOwner(c, x[0])) + ' ' + x[1].toLowerCase() : ''; }).filter(Boolean).slice(0, 3);
      h += '<div class="steps">' + esc(rest.join(' · ')) + '</div>';
    } else {
      h += '<ol class="chain-steps">' + STEPS.map(function (x, i) {
        var done = c[x[0]], o = stepOwner(c, x[0]);
        var r = '<li class="' + (done ? 'd' : i === n ? 'n' : '') + '"><span class="sname">' + esc(x[1]) + '</span><span class="sowner">' + esc(o || '?') + '</span><span class="swhen">' + esc(done ? shortStamp(done) : i === n ? 'waiting' : '') + '</span>';
        if (canStep(c, x[0]) && (done || i === n)) r += '<button class="link small" data-act="chainstep" data-id="' + esc(c.id) + '" data-step="' + x[0] + '">' + (done ? 'Undo' : 'Done') + '</button>';
        return r + '</li>';
      }).join('') + '</ol>';
      var cnt = S.items.filter(function (i) { return same(i.dept, c.list); }).length;
      if (cnt) h += '<p><button class="link" data-act="jump" data-to="dept-' + esc(String(c.list).toLowerCase()) + '">See the ' + cnt + ' item' + (cnt > 1 ? 's' : '') + ' ↓</button></p>';
    }
    return h + '</div>';
  }
  function chainBlock() {
    var cs = chains();
    if (!cs.length && !S.me.admin) return '';
    var h = '<section class="chains"><h2>Kit lists</h2><p class="grey small">Each bar is the five steps: listed, DP OK, confirmed, prepped, on set. Orange is who\'s up next. Tap a list for the detail.</p>';
    h += cs.map(chainRow).join('');
    if (S.me.admin) {
      if (!ui.addChain) h += '<p><button class="link" data-act="addchain">+ Add a kit list</button></p>';
      else {
        h += '<form class="box" data-form="chain"><h2>Add a kit list</h2>';
        h += '<label>List<select name="list">' + DEPTS.map(function (d) { return '<option>' + d + '</option>'; }).join('') + '</select></label>';
        h += '<label>Who lists it<select name="lister"><option></option>' + S.crew.map(function (c) { return '<option>' + esc(c.name) + '</option>'; }).join('') + '</select></label>';
        h += '<label>Who preps & brings it<select name="preps"><option></option>' + S.crew.map(function (c) { return '<option>' + esc(c.name) + '</option>'; }).join('') + '</select></label>';
        h += '<label>List due<input name="due" placeholder="e.g. Mon 30 Nov"></label>';
        h += '<div class="row"><button type="submit">Add</button><button type="button" class="link" data-act="addchain">Cancel</button></div></form>';
      }
    }
    return h + '</section>';
  }
  // Steps waiting on me, for my to-dos.
  function myChainSteps() {
    return chains().filter(function (c) { var n = nextStep(c); return n >= 0 && (S.me.admin ? same(stepOwner(c, STEPS[n][0]), 'Elliot') : canStep(c, STEPS[n][0])); });
  }
  function chainTodoRow(c) {
    var st = STEPS[nextStep(c)];
    return '<li class="item flagrow"><span class="flagmark blue">→</span><div class="body"><div class="name">' + esc(c.list) + ' kit list: ' + esc(st[2].toLowerCase()) + '</div><div class="meta">Kit list step' + (c.due && st[0] === 'listed' ? ' · by ' + esc(c.due) : '') + '</div></div><button class="link" data-act="chainstep" data-id="' + esc(c.id) + '" data-step="' + st[0] + '">' + esc(st[2]) + '</button></li>';
  }

  /* ---------- job chat ---------- */
  function chat() { return ((S && S.chat) || []).slice(-150); }
  function chatSeenKey() { return 'hymn_chat_' + key + '_' + (S && S.job ? S.job.job : job); }
  function chatUnread() {
    var seen = +(store(chatSeenKey()) || 0), all = (S && S.chat) || [];
    return all.filter(function (m, n) { return n >= seen && !same(m.who, S.me.name); }).length;
  }
  function markChatSeen() { store(chatSeenKey(), String(((S && S.chat) || []).length)); }
  function mentionOf(t) {
    var hit = '';
    S.crew.concat([{ name: 'Elliot' }]).some(function (c) { var f = first(c.name); if (f.length > 1 && new RegExp('@' + f + '\\b', 'i').test(t)) { hit = c.name === 'Elliot' ? 'Elliot' : c.name; return true; } });
    return hit;
  }
  function chatText(t) {
    return esc(t).replace(/(^|\s)(@[A-Za-z][\w-]*)/g, '$1<b class="at">$2</b>').replace(/https?:\/\/[^\s<]+/g, function (u) { return '<a target="_blank" rel="noopener" href="' + u + '">' + u + '</a>'; });
  }
  function chatView() {
    var list = chat(), h = '<section class="chat"><ul class="msgs">';
    if (!list.length) h += '<li class="grey">No messages yet. Say hi to the crew.</li>';
    var last = '';
    list.forEach(function (m) {
      var mine = same(m.who, S.me.name);
      h += '<li class="msg' + (mine ? ' me' : '') + '" id="m-' + esc(m.id) + '">';
      if (m.who !== last) h += '<div class="who">' + esc(mine ? 'You' : m.who) + ' <span class="grey small">' + esc(m.time || '') + '</span></div>';
      h += '<div class="said">' + chatText(m.text) + '</div><div class="acts">';
      h += '<button class="link grey small" data-act="chattask" data-id="' + esc(m.id) + '">Make it a task</button>';
      if (mine || S.me.admin) h += '<button class="link grey small" data-act="unsay" data-id="' + esc(m.id) + '">Remove</button>';
      h += '</div></li>';
      last = m.who;
    });
    h += '</ul><form class="say" data-form="say"><input name="text" id="say_text" data-keep="say_text" autocomplete="off" placeholder="Message everyone on the job"><button type="submit">Send</button></form></section>';
    return h;
  }

  // How it works: a short card the first time someone opens their page, & any time from "How it works".
  function tourSteps() {
    var L = [['Open the DP notes', 'The big link at the top is the deck with the look & diagrams. Everything else is under All documents.', 'docs']];
    L.push(['Tick off your to-dos', 'Tap the box next to a to-do when it\'s done. Red ! lines are flags about your job.', 'todo']);
    if (!S.me.admin) L.push(['Add your kit', 'Tap + Add kit under Your kit for anything you\'re bringing or need. Tick it when it\'s packed.', 'mykit']);
    L.push(['Ask someone', 'Ask a question & it shows on their page in yellow until they answer.', 'askform']);
    L.push(['Give someone a task', 'Pick a name, write the task, add a day. It lands on their page.', 'giveTask']);
    L.push(['Flag a problem', 'Something missing or wrong? Flag it & it goes to the right person.', 'flagform']);
    L.push(['Chat with the crew', 'The Chat tab is one chat for everyone on the job. Type @ & a name to point it at someone.', '@chat']);
    L.push(['See what changed', 'The Changes tab lists every update, newest first, with who did it.', '@log']);
    return L;
  }
  function tourSeen() { return !!store('hymn_tour1'); }
  function tourBlock() {
    if (tourSeen() && !ui.tour) return '';
    var h = '<section class="tour" id="tour"><h2>How it works</h2><ol>';
    tourSteps().forEach(function (x) {
      var go = x[2].charAt(0) === '@' ? '<button class="link" data-act="tab" data-t="' + x[2].slice(1) + '">Show me</button>' : '<button class="link" data-act="jump" data-to="' + x[2] + '">Show me</button>';
      h += '<li><b>' + esc(x[0]) + '.</b> ' + esc(x[1]) + ' ' + go + '</li>';
    });
    h += '</ol><p><button data-act="tourdone">Got it</button></p><p class="grey small">Open this again any time from How it works at the bottom.</p></section>';
    return h;
  }

  // The one document most people open first (the DP notes deck), shown big at the top.
  function mainDoc() {
    var d = docLines(), m = null;
    d.some(function (l) { if (/dp notes|deck/i.test(l) && /https?:/.test(l)) { m = l; return true; } });
    return m || d[0] || '';
  }
  function jump(to, label, n) { return '<button class="chip" data-act="jump" data-to="' + esc(to) + '">' + esc(label) + (n != null ? ' <span class="grey">' + n + '</span>' : '') + '</button>'; }
  function secId(title) { return 'sec-' + String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  function mineView() {
    var h = toSendBlock();
    var meRow = S.crew.filter(function (c) { return same(c.name, S.me.name); })[0] || {};
    var mt = myTasks(), todo = mt.filter(function (t) { return !t.done; }), done = mt.filter(function (t) { return t.done; }), mf = myFlags(), tf = thinkFlags(), mc = myChainSteps();
    var reads = S.me.admin ? [] : sectionsFor(meRow).map(function (x) { return x.title; });
    var mi = S.me.admin ? [] : myItems(), docs = docLines();
    if (!S.me.admin) h += '<p class="hello">Hi ' + esc(first(S.me.name)) + '. Open the DP notes, then work down your list.</p>';

    h += tourBlock();
    // Start here: the DP notes deck, then a jump to each part of this page.
    var md = mainDoc();
    h += '<section class="start">';
    if (md) h += '<div class="maindoc">' + linkify(md) + '</div>';
    h += '<div class="chips">' + jump('todo', 'To-dos', todo.length + mf.length + mc.length);
    if (tf.length) h += jump('think', 'To think about', tf.length);
    if (reads.length) h += jump('plan', 'Your plan', reads.length);
    if (!S.me.admin) h += jump('mykit', 'Your kit', mi.length);
    if (docs.length) h += jump('docs', 'All documents', docs.length);
    h += '</div></section>';

    h += '<section class="todo" id="todo"><h2>Your to-dos <span class="grey">(' + (todo.length + mf.length + mc.length) + ')</span></h2>';
    if (!todo.length && !mf.length && !mc.length) h += '<p class="grey">Nothing for you right now.</p>';
    h += '<ul class="items">' + mc.map(chainTodoRow).join('') + todo.map(taskRow).join('') + mf.map(flagRow).join('') + '</ul></section>';
    if (tf.length) h += '<section id="think"><h2>To think about <span class="grey">(' + tf.length + ')</span></h2><p class="grey small">Not yours to sort, but they touch your job.</p><ul class="items">' + tf.map(flagRow).join('') + '</ul></section>';

    if (reads.length) h += '<section id="plan"><h2>Your plan</h2><p class="grey small">The parts of the plan for you. Tap one to go straight to it.</p><div class="chips">' + reads.map(function (r) { return '<button class="chip" data-act="gosec" data-to="' + esc(secId(r)) + '">' + esc(r) + ' →</button>'; }).join('') + '</div></section>';
    if (docs.length) h += docsBlock();

    if (!S.me.admin) {
      h += '<section id="mykit"><h2>Your kit <span class="grey">(' + mi.length + ')</span></h2><p class="grey small">Kit you bring or asked for. Tick it when it\'s packed.</p>';
      h += '<ul class="items">' + mi.map(itemRow).join('') + '</ul>';
      h += addItemBlock();
      h += '<p class="gap"><button class="wide' + (meRow.kit_done ? ' on' : '') + '" data-act="kitdone">' + (meRow.kit_done ? 'My kit is all on the sheet · ' + esc(meRow.kit_done) : 'I\'ve added all my kit') + '</button></p>';
      h += '<p><a class="btn wide-btn update" target="_blank" rel="noopener" href="' + esc(myUpdate()) + '">Send my update</a></p></section>';
    }
    if (done.length) h += '<section><h2>Done <span class="grey">(' + done.length + ')</span></h2><ul class="items">' + done.map(taskRow).join('') + '</ul></section>';
    h += askForm() + asksList();
    h += taskAdder();

    h += '<section id="flagform"><h2>Something wrong?</h2><form class="box" data-form="flag">';
    h += '<label>Problem<input name="text" id="flag_text" data-keep="flag_text" placeholder="e.g. no batteries for the Ember"></label>';
    h += '<div class="row"><button type="submit">Flag it</button></div></form></section>';
    return h;
  }

  function taskRow(t) {
    var h = '<li class="item' + (t.done ? ' packed' : '') + '">';
    h += '<button class="box' + (t.done ? ' on' : '') + '" data-act="task" data-id="' + esc(t.id) + '">' + (t.done ? '×' : '') + '</button>';
    h += '<div class="body"><div class="name">' + esc(t.task) + '</div><div class="meta">' + esc(t.who) + (t.due ? ' · by ' + esc(t.due) : '') + (t.done ? ' · done ' + esc(t.done.split(' · ')[1] || '') : '') + '</div>' + (t.notes ? '<div class="meta">' + esc(t.notes) + '</div>' : '') + '</div>';
    if (S.me.admin) h += '<button class="tick" data-act="deltask" data-id="' + esc(t.id) + '">×</button>';
    return h + '</li>';
  }

  function taskAdder() {
    var h = '<section id="giveTask"><h2>Give someone a task</h2><form class="box" data-form="task">';
    h += '<label>Who<select name="who" data-keep="task_who"><option>Everyone</option>' + crewOptions('') + '</select></label>';
    h += '<label>Task<input name="task" id="task_text" data-keep="task_text" placeholder="e.g. Check Rialto is on the MCX quote"></label>';
    h += '<label>By<input name="due" id="task_due" data-keep="task_due" placeholder="e.g. Wed 12:00"></label>';
    h += '<div class="row"><button type="submit">Add task</button></div></form></section>';
    h += '<section><h2>All tasks</h2><ul class="items">' + S.tasks.map(taskRow).join('') + '</ul></section>';
    return h;
  }

  // Elliot: everyone's link in one place, one tap to copy or WhatsApp.
  function linksBlock() {
    if (!S.me.admin) return '';
    var h = '<section class="links"><h2>Links</h2><ul>';
    S.crew.forEach(function (c) {
      if (!c.key) return;
      var link = linkFor(c.person || c.key);
      var wa = waHref(c, link);
      h += '<li><span>' + esc(c.name) + '</span><span class="row"><button class="link" data-act="copy" data-text="' + esc(link) + '">Copy</button><a class="link" target="_blank" rel="noopener" href="' + esc(wa) + '">WhatsApp</a></span></li>';
    });
    return h + '</ul></section>';
  }

  function crewView() {
    var h = linksBlock() + '<section><h2>Crew <span class="grey">(' + S.crew.length + ')</span></h2><ul class="crew">';
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
          var link = linkFor(c.person || c.key);
          if (c.email) h += '<div class="row"><a class="btn msg" target="_blank" rel="noopener" href="' + esc(messageFor(c)) + '">Message ' + esc(first(c.name)) + '</a></div>';
          h += '<div class="row"><button class="link" data-act="copy" data-text="' + esc(link) + '">Copy link</button>';
          if (!c.person && S.v !== 'pipe-1') h += '<button class="link" data-act="givelink" data-key="' + esc(c.key) + '">Make one link for all jobs</button>';
          h += '<a class="link" target="_blank" rel="noopener" href="' + esc(waHref(c, link)) + '">WhatsApp link</a>';
          if (c.email) h += '<a class="link" target="_blank" rel="noopener" href="' + esc(mailto([c.email], S.job.title + ': prep sheet', inviteEmail(c, link))) + '">Email link</a></div>';
        }
        h += '</div>';
      }
      h += '</div></li>';
    });
    (S.bookings || []).forEach(function (b) {
      h += '<li class="person"><span class="dot"></span><div class="body"><div class="name">' + esc(b.name) + '</div><div class="meta"><span class="tag t-plain">' + esc(b.role) + '</span><span class="sep"> · </span><span class="tag t-yellow">booked by ' + esc(first(b.by)) + ', no link yet</span></div>';
      if (S.me.admin) h += '<div class="row"><button class="link" data-act="givebooking" data-id="' + esc(b.id) + '">Give them a link</button></div>';
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
    var named = secs.filter(function (x) { return x.title; });
    if (named.length > 2) h += '<section class="contents"><div class="chips">' + named.map(function (x) { return '<button class="chip" data-act="jump" data-to="' + esc(secId(x.title)) + '">' + esc(x.title.replace(/\s*\(.*\)\s*$/, '')) + '</button>'; }).join('') + '</div></section>';
    secs.forEach(function (x) {
      h += '<section class="note-sec"' + (x.title ? ' id="' + esc(secId(x.title)) + '"' : '') + '>' + (x.title ? '<h2>' + esc(x.title) + '</h2>' : '') + '<div class="doc">';
      if (/^documents/i.test(x.title)) {
        h += '<ul class="doclist">' + x.lines.map(function (l) { var b = l.match(/^\s*[-•]\s+(.*)/); return b ? '<li>' + linkify(b[1]) + '</li>' : (l.trim() ? '<li>' + linkify(l.trim()) + '</li>' : ''); }).join('') + '</ul></div></section>';
        return;
      }
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

  // "Call sheet v7: https://..." shows as a link called "Call sheet v7" (the Documents list at the top of the notes).
  function linkify(t) {
    var m = String(t).match(/^(.+?):\s+(https?:\/\/\S+)\s*$/);
    if (m && !/https?:/.test(m[1])) {
      // "Camera list V1 (Mike Linforth, 26 Nov)": the name is the link, who & when sit after it in grey.
      var lab = m[1], who = '', w = lab.match(/^(.*?)\s*(\([^()]*\)[^()]*)$/);
      if (w && w[1]) { lab = w[1]; who = w[2]; }
      // Name on the left, arrow pinned to the right edge (it can't wrap), who & when on a small line below.
      return '<a class="doc-link" target="_blank" rel="noopener" href="' + esc(m[2]) + '"><span class="doc-name">' + esc(lab) + '</span><span class="doc-arrow">↗</span></a>' + (who ? '<span class="doc-who">' + esc(who.replace(/^\(([^()]*)\)[.,;:]?\s*/, function (a, b) { return b + ' · '; }).replace(/\s*·\s*$/, '')) + '</span>' : '');
    }
    return esc(t).replace(/https?:\/\/[^\s<]+/g, function (u) { return '<a target="_blank" rel="noopener" href="' + u + '">' + u + '</a>'; }); }

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
    if (c.key) { L.push('Everything\'s on here, tick stuff off as it\'s sorted:'); L.push(linkFor(c.person || c.key)); L.push(''); }
    L.push('Thanks!'); L.push('Elliot');
    return mailto([c.email], S.job.title + ' x ' + first(c.name), L.join('\n'));
  }

  /* Suggested emails for anyone on the sheet. They open in the person's own mail, ready to edit & send. */
  /* Invite wording (Elliot's voice: short, "&", no sign-up talk beyond one line). */
  function roleKind(c) {
    if (BOOKER.test(c.role || '') || /runner/i.test(c.role || '')) return 'prod';
    if (/director/i.test(c.role || '') || c.dept === 'Director') return 'dir';
    if (S.crew.some(function (x) { return x === c; }) && supplierLike(c)) return 'supplier';
    return 'crew';
  }
  function supplierLike(c) { return S.items.some(function (i) { return same(i.supplier, c.role); }); }
  // What's on there for them, one short line.
  function whatToDo(c) {
    var k = roleKind(c);
    if (k === 'prod') return 'Full kit list, what\'s confirmed & who\'s bringing what, plus crew & everyone\'s tasks.';
    if (k === 'dir') return 'Plan, kit & crew all in there.';
    if (k === 'supplier') return 'Camera list with what\'s confirmed & what\'s still open.';
    return 'Kit list, who\'s bringing what, your tasks & the crew.';
  }
  // One line on what's in it for them, by role.
  function benefit(c) {
    var k = roleKind(c), r = (c.role || '') + ' ' + (c.dept || '');
    if (k === 'prod') return 'Should save you chasing me for updates, & you can check the kit against the quote.';
    if (k === 'dir') return 'So you can see where camera\'s at without chasing anyone. Flag anything you wanna change & I\'ll pick it up.';
    if (k === 'supplier') return 'Tick stuff off as it\'s pulled or flag anything you can\'t get.';
    if (/gaffer|spark|electric|lighting/i.test(r)) return 'Stick your lighting list on so we can check it against the plan before the truck\'s loaded.';
    if (/grip/i.test(r)) return 'Stick your grip list & any rigging asks on so they make the quote.';
    if (/dit|data/i.test(r)) return 'Stick your cart, cards & drives on so data\'s sorted before the day.';
    if (/video|playback|vtr/i.test(r)) return 'Stick your monitors & wireless on so we know what\'s covered.';
    if (/focus|ac\b|camera|clapper|loader|operator|steadicam/i.test(r)) return 'Stick your own kit on (focus package, batteries, monitors etc) so nothing gets doubled up or missed.';
    return 'Stick anything you need on so nothing gets missed.';
  }
  function inviteEmail(c, link) {
    return 'Heya ' + first(c.name) + ', hope ya good!\n\n' +
      'I\'m getting messages from all angles on jobs so I\'ve put everything for ' + S.job.title + ' in one place:\n\n' +
      link + '\n\n' + whatToDo(c) + ' ' + benefit(c) + '\n\n' +
      'It\'s your own link, no sign up, & works for any jobs we do together. Worth saving to your home screen.\n\n' +
      'Lmk if anything\'s off!\n\nThanks,\nElliot';
  }
  function inviteWhatsApp(c, link) {
    return 'heya ' + first(c.name).toLowerCase() + '!\n\n' +
      'putting everything for ' + S.job.title + ' in one place so it\'s not all over whatsapp\n\n' +
      link + '\n\n' + whatToDo(c).toLowerCase() + '\n\n' + benefit(c).toLowerCase() + '\n\n' +
      'your own link, no sign up, works for future jobs too\n\nlmk if anything\'s off';
  }
  function waHref(c, link) { return 'https://wa.me/' + (c.phone || '').replace(/[^\d]/g, '').replace(/^0/, '44') + '?text=' + encodeURIComponent(inviteWhatsApp(c, link)); }

  function production() { return S.crew.filter(function (c) { return BOOKER.test(c.role || '') && c.email; }); }
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
    var f = fresh();
    return '<section><h2>Changes</h2><ol class="log">' + S.log.map(function (l) {
      return '<li' + (f.indexOf(l) >= 0 ? ' class="new"' : '') + '><span class="grey">' + esc(l.time) + '</span> <span>' + esc(l.who) + '</span> <span class="grey">' + esc(l.what) + '</span></li>';
    }).join('') + '</ol></section>';
  }

  /* ---------- events ---------- */
  function findItem(id) { return S.items.filter(function (i) { return i.id === id; })[0]; }
  function stamp() { return S.me.name + ' · now'; }
  function doTick(a, id, note) {
    if (a === 'task') { return send({ a: 'tick_task', id: id, note: note }, function () { var k = S.tasks.filter(function (x) { return x.id === id; })[0]; k.done = k.done ? '' : stamp(); if (note) k.notes = (k.notes ? k.notes + ' · ' : '') + note; }); return; }
    var field = a === 'pack' ? 'packed' : 'confirmed';
    return send({ a: 'tick_item', id: id, field: field, note: note }, function () { var i = findItem(id); i[field] = i[field] ? '' : stamp(); if (note) i.notes = (i.notes ? i.notes + ' · ' : '') + note; });
  }
  // Tapping a tick opens a small card: "NDs confirmed" + an optional note, so ticking feels like logging it, not a scary button.
  function tickInfo(p) {
    var t, on, name;
    if (p.a === 'task') { t = S.tasks.filter(function (x) { return x.id === p.id; })[0]; if (!t) return null; on = !!t.done; name = t.task; }
    else { t = findItem(p.id); if (!t) return null; on = !!t[p.a === 'pack' ? 'packed' : 'confirmed']; name = t.item; }
    var word = p.a === 'task' ? (on ? 'reopened' : 'done') : p.a === 'pack' ? (on ? 'not packed' : 'packed') : (on ? 'not confirmed' : 'confirmed');
    return { on: on, name: name, word: word };
  }
  function sureBar() {
    var p = ui.sure; if (!p) return '';
    var x = tickInfo(p); if (!x) return '';
    var h = '<form class="sure" data-form="sure" role="dialog"><p><b>' + esc(x.name) + '</b> ' + esc(x.word) + '</p>';
    if (!x.on) h += '<input name="note" id="sure_note" data-keep="sure_note" autocomplete="off" placeholder="Add a note (optional)">';
    h += '<div class="row"><button type="submit" class="yes">' + (x.on ? 'Undo it' : 'Log it') + '</button><button type="button" class="link" data-act="sureno">Cancel</button></div>';
    h += '<p class="grey small">Goes on the Log with your name. Tap again any time to undo.</p></form>';
    return h;
  }

  root.addEventListener('click', function (e) {
    if (e.target.closest('a')) return; // links (call, email, WhatsApp) just open
    var t = e.target.closest('[data-tab],[data-act]');
    if (!t) return;
    if (t.hasAttribute('data-tab')) { ui.tab = t.getAttribute('data-tab'); store('hymn_tab2', ui.tab); ui.open = null; render(); if (ui.tab !== 'chat') window.scrollTo(0, 0); return; }
    var a = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    if (a === 'filter') { ui.filter = ui.filter === t.getAttribute('data-f') ? 'all' : t.getAttribute('data-f'); ui.tab = 'kit'; render(); return; }
    if (a === 'openitem') { ui.open = ui.open === id ? null : id; render(); return; }
    if (a === 'adding') { ui.adding = !ui.adding; render(); var f = document.getElementById('add_item'); if (f) f.focus(); return; }
    if (a === 'editnotes') { ui.editNotes = !ui.editNotes; render(); return; }
    if (a === 'allflags') { ui.allFlags = !ui.allFlags; render(); return; }
    if (a === 'job') {
      job = t.getAttribute('data-job'); store('hymn_job_' + key, job);
      var cached = load('hymn_state_' + key + '_' + job);
      var pick = (S.jobs || []).filter(function (x) { return x.job === job; })[0] || { job: job };
      S = cached || { v: S.v, me: S.me, jobs: S.jobs, job: { job: job, title: pick.title, dates: pick.dates }, crew: [], items: [], tasks: [], shots: [], flags: [], log: [], loading: true };
      ui.open = null; ui.dismissed = false; ui.filter = 'all';
      status = { text: cached ? 'Updating…' : 'Opening ' + (pick.title || job) + '…', bad: false };
      render(); window.scrollTo(0, 0);
      var want = job;
      get().then(function (d) { if (want !== job) return; took(d); render(); }).catch(function () { offline(); });
      return;
    }
    if (a === 'givelink') { send({ a: 'give_link', key: t.getAttribute('data-key') }); return; }
    if (a === 'seenanswers') { save('hymn_asks_' + key, askSeen().concat(newAnswers().map(function (q) { return q.id; })).slice(-200)); render(); return; }
    if (a === 'askitem') { var ai = findItem(id); ui.askAbout = ai ? ai.item : ''; ui.askTo = ai && ai.owner && !same(ai.owner, S.me.name) ? ai.owner : 'Elliot'; ui.open = null; ui.tab = 'mine'; store('hymn_tab2', 'mine'); render(); var af = document.getElementById('askform'); if (af) af.scrollIntoView(); var at = document.getElementById('ask_text'); if (at) at.focus(); return; }
    if (a === 'askclear') { ui.askAbout = ''; render(); return; }
    if (a === 'delask') { send({ a: 'delete_ask', id: id }, function () { S.asks = asks().filter(function (q) { return q.id !== id; }); }); return; }
    if (a === 'booknow') { var br = t.getAttribute('data-role'); ui.booking = br && ui.booking !== br ? br : null; render(); var bn = document.getElementById('book_name'); if (bn) bn.focus(); return; }
    if (a === 'givebooking') { send({ a: 'give_booking', id: id }); return; }
    if (a === 'gotit') { ui.dismissed = true; lastLook = Date.now(); markSeen(); render(); return; }
    if (a === 'chainopen') { ui.openChain = ui.openChain === id ? null : id; render(); return; }
    if (a === 'addchain') { ui.addChain = !ui.addChain; render(); return; }
    if (a === 'chainstep') {
      var cs = t.getAttribute('data-step');
      send({ a: 'chain_step', id: id, step: cs }, function () { var c = chains().filter(function (x) { return x.id === id; })[0]; if (c) c[cs] = c[cs] ? '' : S.me.name + ' · now'; });
      return;
    }
    if (a === 'chainremind') {
      var rc = chains().filter(function (x) { return x.id === id; })[0]; if (!rc) return;
      var rs = STEPS[nextStep(rc)], rw = first(stepOwner(rc, rs[0]));
      ui.tab = 'chat'; store('hymn_tab2', 'chat'); render();
      var sti = document.getElementById('say_text');
      if (sti) { sti.value = '@' + rw + ' ' + rc.list.toLowerCase() + ' kit list: waiting on you ' + rs[3] + (rc.due && rs[0] === 'listed' ? ' (by ' + rc.due + ')' : '') + ' '; sti.focus(); }
      return;
    }
    if (a === 'unsay') { send({ a: 'unsay', id: id }, function () { S.chat = chat().filter(function (m) { return m.id !== id; }); }); return; }
    if (a === 'chattask') {
      var cmsg = chat().filter(function (m) { return m.id === id; })[0];
      if (!cmsg) return;
      var who = mentionOf(cmsg.text) || (same(cmsg.who, S.me.name) ? '' : cmsg.who);
      ui.tab = 'mine'; store('hymn_tab2', 'mine'); render();
      var tt = document.getElementById('task_text'), tw = root.querySelector('[data-keep="task_who"]');
      if (tt) tt.value = cmsg.text.replace(/(^|\s)@[A-Za-z][\w-]*/g, '$1').trim();
      if (tw && who) Array.prototype.forEach.call(tw.options, function (o) { if (same(o.value || o.text, who)) tw.value = o.value || o.text; });
      var gt = document.getElementById('giveTask'); if (gt) gt.scrollIntoView();
      if (tt) tt.focus();
      return;
    }
    if (a === 'tourdone') { store('hymn_tour1', '1'); ui.tour = false; render(); window.scrollTo(0, 0); return; }
    if (a === 'tour') { ui.tour = true; ui.tab = 'mine'; store('hymn_tab2', 'mine'); render(); var te = document.getElementById('tour'); if (te) te.scrollIntoView(); return; }
    if (a === 'jump') { var je = document.getElementById(t.getAttribute('data-to')); if (je) je.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (a === 'gosec') { ui.tab = 'notes'; store('hymn_tab2', 'notes'); render(); var ge = document.getElementById(t.getAttribute('data-to')); if (ge) ge.scrollIntoView(); else window.scrollTo(0, 0); return; }
    if (a === 'tab') { ui.tab = t.getAttribute('data-t'); store('hymn_tab2', ui.tab); render(); return; }
    if (a === 'editjob') { ui.editJob = !ui.editJob; render(); return; }
    if (a === 'addcrew') { ui.addCrew = !ui.addCrew; render(); return; }
    if (a === 'crewopen') { var n = +t.getAttribute('data-n'); ui.crewOpen = ui.crewOpen === n ? null : n; render(); return; }
    if (a === 'copy') { copy(t.getAttribute('data-text')); t.textContent = 'Copied'; return; }
    if (a === 'pack' || a === 'confirm' || a === 'task') {
      ui.sure = { a: a, id: id }; render(); return;
    }
    if (a === 'sureno') { ui.sure = null; render(); return; }

    if (a === 'delitem') { send({ a: 'delete_item', id: id }, function () { S.items = S.items.filter(function (i) { return i.id !== id; }); ui.open = null; }); return; }
    if (a === 'deltask') { send({ a: 'delete_task', id: id }, function () { S.tasks = S.tasks.filter(function (x) { return x.id !== id; }); }); return; }
    if (a === 'kitdone') { send({ a: 'kit_done' }, function () { var c = S.crew.filter(function (x) { return same(x.name, S.me.name); })[0]; if (c) c.kit_done = c.kit_done ? '' : 'now'; }); return; }
    if (a === 'msgsent') { send({ a: 'set', tab: 'dp_send', id: id, fields: { sent: '@stamp' } }, function () { var m = (S.dp_send || []).filter(function (x) { return x.id === id; })[0]; if (m) m.sent = stamp(); }); return; }
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

    if (kind === 'booking') {
      if (!v.name) return;
      clear(); ui.booking = null;
      if (S.me.admin) send({ a: 'add_crew', name: v.name, role: v.role, email: v.email, phone: v.phone, dept: window.HymnRules.deptFor ? window.HymnRules.deptFor(v.role) : 'Other' });
      else send({ a: 'add_booking', name: v.name, role: v.role, email: v.email, phone: v.phone }, function () { S.bookings = (S.bookings || []).concat([{ id: 'tmp' + Date.now(), name: v.name, role: v.role, by: S.me.name }]); });
      return;
    }
    if (kind === 'sure') {
      var sp = ui.sure; ui.sure = null;
      if (!sp) return render();
      var sx = tickInfo(sp);
      var done = sx ? sx.name + ' ' + sx.word : '';
      doTick(sp.a, sp.id, v.note).then(function () {
        if (!done || status.bad || queue.length) return;
        status = { text: done, bad: false }; paintStatus();
        setTimeout(function () { if (status.text === done) { status = { text: '', bad: false }; paintStatus(); } }, 2000);
      });
      return;
    }
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
    } else if (kind === 'chain') {
      ui.addChain = false;
      send({ a: 'add_chain', list: v.list, lister: v.lister, preps: v.preps, due: v.due }, function () { S.chain = chains().concat([{ id: 'tmp' + Date.now(), list: v.list, lister: v.lister, preps: v.preps, due: v.due }]); });
    } else if (kind === 'say') {
      if (!v.text) return;
      clear();
      send({ a: 'say', text: v.text }, function () { S.chat = chat().concat([{ id: 'tmp' + Date.now(), who: S.me.name, text: v.text, time: 'now' }]); markChatSeen(); });
      ui.chatScroll = true;
    } else if (kind === 'ask') {
      if (!v.text) return;
      var about = ui.askAbout || '';
      clear(); ui.askAbout = ''; ui.askTo = '';
      send({ a: 'ask', to: v.to, text: v.text, about: about }, function () { S.asks = asks().concat([{ id: 'tmp' + Date.now(), to: v.to, from: S.me.name, about: about, text: v.text, answer: '', asked: 'now' }]); });
    } else if (kind === 'answer') {
      var qid = f.getAttribute('data-id');
      if (!v.text) return;
      clear();
      send({ a: 'answer', id: qid, text: v.text }, function () { var q = asks().filter(function (x) { return x.id === qid; })[0]; if (q) { q.answer = v.text; q.answered_by = S.me.name; q.answered = 'now'; } });
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
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () { prompt('Copy this', text); });
    else prompt('Copy this', text);
  }

  /* ---------- polling ---------- */
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { if (!document.hidden) refresh().then(schedule, schedule); else schedule(); }, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); markSeen(); return; }
    // Back after a while: what's new is measured from when they left.
    if (hiddenAt && Date.now() - hiddenAt > 30 * 60000) { lastLook = hiddenAt; ui.dismissed = false; }
    refresh();
  });
  window.addEventListener('pagehide', markSeen);
  window.addEventListener('online', function () { refresh(); });

  /* ---------- start ---------- */
  if (!API) { fatal('Not switched on yet. Elliot needs to paste the script link into config.js.'); return; }
  if (!key) { fatal('Open the link Elliot sent you. Each person has their own.'); return; }
  if (NICE && location.protocol === 'http:') { location.replace('https://' + location.host + location.pathname + location.search); return; }
  setTimeout(function () {
    var b = root.querySelector('.boot');
    if (b) b.textContent = 'Hymn Sheet. Still loading, the first load can take 10 seconds or so…';
  }, 6000);
  upgradeLink().then(function (moved) {
    if (moved) return;
    if (S) render();
    refresh().then(schedule, schedule);
  });

  /* Old per-job links (?k=…) swap themselves for the person's forever link.
     links.json maps them, encrypted with the old key, so the file is no use
     to anyone without that key. */
  function upgradeLink() {
    var C = window.crypto && window.crypto.subtle;
    if (!C || PERSON.test(key) || !window.TextEncoder) return Promise.resolve(false);
    var enc = new TextEncoder();
    function b(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
    function kdf(salt, it, bits) {
      return C.importKey('raw', enc.encode(key), 'PBKDF2', false, ['deriveBits'])
        .then(function (k) { return C.deriveBits({ name: 'PBKDF2', salt: salt, iterations: it, hash: 'SHA-256' }, k, bits); });
    }
    return fetch('links.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (L) {
      if (!L || !L.links) return false;
      return kdf(enc.encode('hymn-index'), L.it, 128).then(function (bits) {
        var id = btoa(String.fromCharCode.apply(null, new Uint8Array(bits)));
        var e = L.links[id];
        if (!e) return false;
        return kdf(b(e.s), L.it, 256)
          .then(function (raw) { return C.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); })
          .then(function (k) { return C.decrypt({ name: 'AES-GCM', iv: b(e.i) }, k, b(e.c)); })
          .then(function (plain) {
            var nk = new TextDecoder().decode(plain);
            if (!PERSON.test(nk)) return false;
            var j = S && S.job && S.job.job;
            store('hymn_key', nk); if (j) store('hymn_job_' + nk, j);
            location.replace(NICE ? '/' + nk : location.pathname + '?k=' + nk);
            return true;
          });
      });
    }).catch(function () { return false; });
  }
})();

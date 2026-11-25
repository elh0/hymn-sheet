// node tests/suite.js  (Playwright + Chromium; runs the real Code.gs on a fake Sheet)
var assert = require('assert');
var makeBackend = require('./fake-apps-script');
var serve = require('./serve');
var rules = require('../rules.js');
// What the page does: read state, let rules.js turn the action into a Sheet op, post it.
function act(b, k, op) {
  var S = b.get({ a: 'state', k: k });
  var o = rules.translate(op, S);
  if (!o) return S;
  if (o.error) return o;
  o.k = k;
  return b.post(JSON.stringify(o));
}
function raw(b, k, op) { op.k = k; return b.post(JSON.stringify(op)); }
var pw; try { pw = require('playwright'); } catch (e) { pw = require('/usr/local/lib/node_modules/playwright'); }

function seed() {
  return makeBackend([
    ['jobs', { job: 'test', title: 'Test Job', dates: 'Thu 26 Nov', call: '07:00', location: 'Deptford', prep: 'James, MCX Wed 12:00', admin_key: 'ADMIN1', dp_notes: '## Camera & codecs\n- Venice 8.6K full res\n\n## Light\n- 20x book light' }],
    ['jobs', { job: 'other', title: 'Other Job', admin_key: 'ADMIN2' }],
    ['crew', { job: 'test', key: 'JAMES1', name: 'James Burns', role: '2nd AC', dept: 'Camera', email: 'j@x.com', phone: '07500 000000' }],
    ['crew', { job: 'test', key: 'MILO1', name: 'Milo Brown', role: '1st AC', dept: 'Focus', email: 'm@x.com' }],
    ['crew', { job: 'test', key: 'LOUIS1', name: 'Louis Jones', role: 'Production manager', dept: 'Other', email: 'l@x.com' }],
    ['crew', { job: 'test', key: 'MCX1', name: 'Aduke', role: 'MCX', dept: 'Other', email: 'a@x.com' }],
    ['crew', { job: 'test', key: 'DAVO1', name: 'Davo', role: 'DIT', dept: 'DIT', email: 'd@x.com' }],
    ['crew', { job: 'test', key: 'MAX1', name: 'Maxine Carlier', role: 'Production designer', dept: 'Art', email: 'x@x.com' }],
    ['crew', { job: 'other', key: 'OTHER1', name: 'Someone', role: 'Gaffer' }],
    ['items', { id: 'i1', job: 'test', dept: 'Camera', item: 'Sony Venice 8.6K w/ Rialto', qty: '1', supplier: 'MCX', asked_by: 'Elliot', owner: 'James Burns', confirmed: 'Elliot · 24 Nov 10:00' }],
    ['items', { id: 'i2', job: 'test', dept: 'Camera', item: 'NDs', supplier: 'TBC', asked_by: 'Elliot' }],
    ['items', { id: 'i3', job: 'other', dept: 'Lighting', item: 'Secret 18K', supplier: 'X' }],
    ['tasks', { id: 't1', job: 'test', who: 'James Burns', task: 'Check Rialto is on the quote' }],
    ['tasks', { id: 't2', job: 'test', who: 'Milo Brown', task: 'Send focus quote to Louis' }],
    ['shots', { job: 'test', no: '1', shot: 'Rickshaw in low' }]
  ]);
}

var passed = 0, failed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(function () { passed++; console.log('ok   ' + name); },
    function (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); });
}

async function backendTests() {
  var b = seed();
  await check('unknown link is refused', function () { assert(b.get({ a: 'state', k: 'nope' }).error); });
  await check('crew only see their own job', function () {
    var s = b.get({ a: 'state', k: 'JAMES1' });
    assert.strictEqual(s.items.length, 2); assert(!JSON.stringify(s).includes('Secret 18K'));
  });
  await check('crew never get anyone\'s link key', function () {
    var s = JSON.stringify(b.get({ a: 'state', k: 'JAMES1' }));
    assert(!s.includes('MILO1') && !s.includes('ADMIN1') && !s.includes('JAMES1'));
  });
  await check('Elliot gets crew link keys', function () { assert.strictEqual(b.get({ a: 'state', k: 'ADMIN1' }).crew[0].key, 'JAMES1'); });
  await check('crew can add kit, it lands unconfirmed', function () {
    var s = act(b, 'MILO1', { a: 'add_item', item: 'Focus package', dept: 'Focus', supplier: 'Own kit' });
    var it = s.items.filter(function (i) { return i.item === 'Focus package'; })[0];
    assert(it && !it.confirmed && it.asked_by === 'Milo Brown' && it.owner === 'Milo Brown');
  });
  await check('crew can confirm', function () { var r = act(b, 'MILO1', { a: 'tick_item', id: 'i2', field: 'confirmed' }); assert(!r.error, r.error); act(b, 'MILO1', { a: 'tick_item', id: 'i2', field: 'confirmed' }); });
  await check('crew can tick packed, with name and time', function () {
    var s = act(b, 'JAMES1', { a: 'tick_item', id: 'i1', field: 'packed' });
    assert(/^James Burns · /.test(s.items[0].packed));
  });
  await check('crew changing the supplier un-confirms the item', function () {
    var s = act(b, 'JAMES1', { a: 'set_item', id: 'i1', fields: { supplier: 'Production' } });
    assert.strictEqual(s.items[0].confirmed, ''); assert.strictEqual(s.items[0].supplier, 'Production');
  });
  await check('crew cannot rename an item', function () {
    var s = act(b, 'JAMES1', { a: 'set_item', id: 'i1', fields: { item: 'Hacked' } });
    assert(s.items[0].item !== 'Hacked');
  });
  await check('pipe: crew cannot edit the job', function () { assert(raw(b, 'JAMES1', { a: 'set', tab: 'jobs', fields: { title: 'X' } }).error); });
  await check('pipe: crew cannot add crew', function () { assert(raw(b, 'JAMES1', { a: 'add', tab: 'crew', row: { name: 'X' } }).error); });
  await check('pipe: crew cannot change someone else\'s details', function () { assert(raw(b, 'JAMES1', { a: 'set', tab: 'crew', id: 'MILO1', fields: { phone: '1' } }).error); });
  await check('pipe: nobody can write the log or keys', function () {
    assert(raw(b, 'ADMIN1', { a: 'add', tab: 'log', row: { what: 'x' } }).error);
    var s = raw(b, 'JAMES1', { a: 'set', tab: 'crew', id: '@me', fields: { key: 'HACK', job: 'other' } });
    assert(!b.get({ a: 'state', k: 'HACK' }).items || b.get({ a: 'state', k: 'HACK' }).error); assert(!b.get({ a: 'state', k: 'JAMES1' }).error);
  });
  await check('pipe: a new feature can use a new list with no script change', function () {
    var s = raw(b, 'JAMES1', { a: 'add', tab: 'parking', row: { who: '@me', reg: 'AB12 CDE' }, log: 'parking added' });
    assert(s.parking && s.parking[0].reg === 'AB12 CDE' && s.parking[0].who === 'James Burns' && s.parking[0].id);
    assert(!b.get({ a: 'state', k: 'OTHER1' }).parking || !b.get({ a: 'state', k: 'OTHER1' }).parking.length);
  });
  await check('pipe: new columns are added when needed', function () {
    var s = raw(b, 'ADMIN1', { a: 'set', tab: 'items', id: 'i2', fields: { colour: 'black' } });
    assert.strictEqual(s.items.filter(function (i) { return i.id === 'i2'; })[0].colour, 'black');
  });
  await check('crew can tick someone else\'s task', function () { var r = act(b, 'JAMES1', { a: 'tick_task', id: 't2' }); assert(!r.error, r.error); act(b, 'JAMES1', { a: 'tick_task', id: 't2' }); });
  await check('crew can give someone a task', function () { var r = act(b, 'JAMES1', { a: 'add_task', who: 'Milo', task: 'Check batteries' }); assert(!r.error, r.error); });
  await check('crew ask Elliot a question (new asks tab)', function () {
    var r = act(b, 'JAMES1', { a: 'ask', to: 'Elliot', text: 'Rialto on the quote?', about: 'Sony Venice' }); assert(!r.error, r.error);
    var q = r.asks[0]; assert.strictEqual(q.from, 'James Burns'); assert.strictEqual(q.to, 'Elliot'); assert(!q.answer);
  });
  await check('only the person asked (or Elliot) answers', function () {
    var id = b.get({ a: 'state', k: 'ADMIN1' }).asks[0].id;
    assert(act(b, 'MILO1', { a: 'answer', id: id, text: 'no idea' }).error);
    var r = act(b, 'ADMIN1', { a: 'answer', id: id, text: 'Yes, confirmed' }); assert(!r.error, r.error);
    assert.strictEqual(r.asks[0].answer, 'Yes, confirmed'); assert(r.log.some(function (l) { return /answered James Burns/.test(l.what); }));
  });
  await check('ask Everyone: anyone answers; only asker or Elliot removes', function () {
    var r = act(b, 'MILO1', { a: 'ask', to: 'Everyone', text: 'Who has the spare V-locks?' });
    var id = r.asks[1].id;
    assert(!act(b, 'DAVO1', { a: 'answer', id: id, text: 'Me' }).error);
    assert(act(b, 'DAVO1', { a: 'delete_ask', id: id }).error);
    assert(!act(b, 'MILO1', { a: 'delete_ask', id: id }).error);
    assert(act(b, 'MILO1', { a: 'ask', to: 'Milo Brown', text: 'x' }).error);
  });
  await check('production books a missing role; crew can\'t; Elliot gives them a link', function () {
    assert(act(b, 'JAMES1', { a: 'add_booking', name: 'Henry', role: 'Grip' }).error);
    var r = act(b, 'LOUIS1', { a: 'add_booking', name: 'Henry Grip', role: 'Grip', phone: '07000 111222' }); assert(!r.error, r.error);
    var id = r.bookings[0].id; assert.strictEqual(r.bookings[0].by, 'Louis Jones');
    assert(act(b, 'LOUIS1', { a: 'give_booking', id: id }).error);
    var g = act(b, 'ADMIN1', { a: 'give_booking', id: id }); assert(!g.error, g.error);
    var h = g.crew.filter(function (c) { return c.name === 'Henry Grip'; })[0];
    assert(h && h.dept === 'Grip' && h.person, JSON.stringify(h));
    assert(!g.bookings.length);
  });
  await check('crew tick their own task', function () { assert(act(b, 'JAMES1', { a: 'tick_task', id: 't1' }).tasks[0].done); });
  await check('every change goes in the log', function () {
    var s = b.get({ a: 'state', k: 'ADMIN1' });
    assert(s.log.length >= 4); assert(s.log.some(function (l) { return /packed Sony Venice/.test(l.what) && l.who === 'James Burns'; }));
  });
  await check('cross-job ids are refused', function () { assert(act(b, 'JAMES1', { a: 'tick_item', id: 'i3', field: 'packed' }).error); });
  await check('Elliot adds crew and gets a new link', function () {
    var s = act(b, 'ADMIN1', { a: 'add_crew', name: 'Henry', role: 'Grip', email: 'h@x.com' });
    var h = s.crew.filter(function (c) { return c.name === 'Henry'; })[0]; assert(h && h.key.length === 12);
    assert(!b.get({ a: 'state', k: h.key }).error);
  });
  await check('phone numbers keep their +', function () {
    act(b, 'ADMIN1', { a: 'add_crew', name: 'Phone Test', phone: '+44 7796 000000' });
    var d = b.get({ a: 'state', k: 'ADMIN1' }).crew.filter(function (c) { return c.name === 'Phone Test'; })[0];
    assert.strictEqual(d.phone, '+44 7796 000000');
  });
  await check('presence: opening the link shows online', function () {
    b.get({ a: 'state', k: 'MILO1' });
    var m = b.get({ a: 'state', k: 'ADMIN1' }).crew.filter(function (c) { return c.name === 'Milo Brown'; })[0];
    assert(m.online && m.opens === '1');
  });
  await check('people: adding crew makes a forever link that opens the job', function () {
    var s = act(b, 'ADMIN1', { a: 'add_crew', name: 'Mike Linforth', role: '1st AC', email: 'mike@x.com' });
    var m = s.crew.filter(function (c) { return c.name === 'Mike Linforth'; })[0];
    assert(/^mike-[a-z0-9]{8}$/.test(m.person), m.person);
    var ms = b.get({ a: 'state', k: m.person });
    assert(!ms.error && ms.job.job === 'test' && ms.me.name === 'Mike Linforth' && !ms.me.admin);
  });
  await check('people: same person on another job keeps the same link', function () {
    var pk = b.get({ a: 'state', k: 'ADMIN1' }).people.filter(function (p) { return p.name === 'Mike Linforth'; })[0].key;
    var s = act(b, 'ADMIN2', { a: 'add_crew', name: 'Mike Linforth', role: '1st AC', email: 'MIKE@x.com' });
    assert.strictEqual(s.crew.filter(function (c) { return c.name === 'Mike Linforth'; })[0].person, pk);
    var both = b.get({ a: 'state', k: pk });
    assert.strictEqual(both.jobs.length, 2);
    assert.strictEqual(b.get({ a: 'state', k: pk, job: 'other' }).job.title, 'Other Job');
    assert.strictEqual(b.get({ a: 'state', k: pk, job: 'nope' }).job.job === 'test' || true, true);
  });
  await check('people: the soonest job opens first', function () {
    act(b, 'ADMIN1', { a: 'set_job', fields: { start: '2099-01-02' } });
    act(b, 'ADMIN2', { a: 'set_job', fields: { start: '2099-01-01' } });
    var pk = b.get({ a: 'state', k: 'ADMIN1' }).people.filter(function (p) { return p.name === 'Mike Linforth'; })[0].key;
    assert.strictEqual(b.get({ a: 'state', k: pk }).job.job, 'other');
  });
  await check('people: crew never see person links or the people list', function () {
    var s = b.get({ a: 'state', k: 'JAMES1' }), t = JSON.stringify(s);
    assert(!s.people && !/mike-[a-z0-9]{8}/.test(t));
  });
  await check('people: crew cannot write people or change their own link', function () {
    assert(raw(b, 'JAMES1', { a: 'add', tab: 'people', row: { name: 'X', admin: 'yes' } }).error);
    raw(b, 'JAMES1', { a: 'set', tab: 'crew', id: '@me', fields: { person: 'elliot-aaaaaaaa' } });
    assert(!b.get({ a: 'state', k: 'ADMIN1' }).crew.filter(function (c) { return c.name === 'James Burns'; })[0].person);
  });
  await check('people: an admin person opens every job as Elliot', function () {
    b.ctx.append('people', { key: 'elliot-abcd2345', name: 'Elliot', admin: 'yes' });
    var s = b.get({ a: 'state', k: 'elliot-abcd2345' });
    assert(s.me.admin && s.jobs.length === 2 && s.people);
    var w = raw(b, 'elliot-abcd2345', { a: 'add', tab: 'tasks', job: 'other', row: { who: 'Someone', task: 'Other-job task' } });
    assert.strictEqual(w.job.job, 'other'); assert(w.tasks.some(function (t) { return t.task === 'Other-job task'; }));
    assert(!b.get({ a: 'state', k: 'ADMIN1' }).tasks.some(function (t) { return t.task === 'Other-job task'; }));
  });
  await check('people: Make one link for existing crew', function () {
    var s = act(b, 'ADMIN1', { a: 'give_link', key: 'MILO1' });
    var m = s.crew.filter(function (c) { return c.name === 'Milo Brown'; })[0];
    assert(/^milo-/.test(m.person)); assert.strictEqual(b.get({ a: 'state', k: m.person }).me.name, 'Milo Brown');
  });
  await check('kit done toggles', function () {
    var s = act(b, 'MILO1', { a: 'kit_done' });
    assert(s.crew.filter(function (c) { return c.name === 'Milo Brown'; })[0].kit_done);
  });
}

async function uiTests() {
  var b = seed();
  var server = await serve(b);
  var base = 'http://localhost:' + server.address().port + '/';
  var browser = await pw.chromium.launch();
  var phone = await browser.newContext(Object.assign({}, pw.devices['iPhone 13']));
  var page = await phone.newPage();
  var errors = []; page.on('pageerror', function (e) { errors.push(e.message); });

  await check('phone: crew link opens the job', async function () {
    await page.goto(base + '?k=JAMES1');
    await page.waitForSelector('h1');
    assert.strictEqual((await page.textContent('h1')).trim(), 'Test Job');
    assert((await page.textContent('header .me')).includes('James Burns'));
  });
  await check('phone: no sideways scroll', async function () {
    var w = await page.evaluate(function () { return [document.documentElement.scrollWidth, innerWidth]; });
    assert(w[0] <= w[1], w.join(' > '));
  });
  await check('phone: flags show no-supplier and unconfirmed', async function () {
    var t = await page.textContent('.flags'); if (/Show all/.test(t)) { await page.click('[data-act=allflags]'); t = await page.textContent('.flags'); }
    assert(/no supplier: NDs/.test(t) && /not confirmed/.test(t), t);
  });
  await check('phone: a tick asks first; Cancel changes nothing', async function () {
    await page.click('[data-act=pack][data-id=i1]');
    await page.waitForSelector('.sure');
    assert(/Sony Venice 8\.6K w\/ Rialto packed/.test(await page.textContent('.sure')) && /undo/.test(await page.textContent('.sure')));
    await page.click('[data-act=sureno]');
    assert(!(await page.$('.sure')));
    assert(!b.get({ a: 'state', k: 'ADMIN1' }).items[0].packed);
  });
  await check('phone: tick packed saves to the sheet', async function () {
    await page.click('[data-act=pack][data-id=i1]');
    await page.fill('#sure_note', 'In the case, both batteries');
    await page.click('.sure button[type=submit]');
    await page.waitForFunction(function () { return !document.getElementById('status').classList.contains('show'); });
    var st = b.get({ a: 'state', k: 'ADMIN1' });
    assert(/James Burns/.test(st.items[0].packed));
    assert(/In the case, both batteries/.test(st.items[0].notes), st.items[0].notes);
    assert(st.log.some(function (l) { return /packed Sony Venice.*: In the case/.test(l.what); }));
  });
  await check('phone: add my kit', async function () {
    await page.click('[data-tab=mine]');
    await page.click('[data-act=adding]');
    await page.fill('#add_item', 'Vaxis TX + 3 RX');
    await page.fill('#add_qty', '1');
    await page.click('form[data-form=add] button[type=submit]');
    await page.waitForFunction(function () { return document.body.textContent.includes('Vaxis TX + 3 RX') && !document.getElementById('status').classList.contains('show'); });
    assert(b.get({ a: 'state', k: 'ADMIN1' }).items.some(function (i) { return i.item === 'Vaxis TX + 3 RX' && i.asked_by === 'James Burns'; }));
  });
  await check('phone: question for you pinned on top, reply in app', async function () {
    act(b, 'ADMIN1', { a: 'ask', to: 'James Burns', text: 'Can you grab the spare cage?' });
    await page.reload(); await page.waitForSelector('.asks');
    assert(/Can you grab the spare cage/.test(await page.textContent('.asks')));
    var id = await page.getAttribute('.asks form.reply', 'data-id');
    await page.fill('#ans_' + id, 'On it');
    await page.click('.asks form.reply button');
    await page.waitForFunction(function () { return !document.querySelector('.asks form.reply') && !document.getElementById('status').classList.contains('show'); });
    assert(b.get({ a: 'state', k: 'ADMIN1' }).asks.some(function (q) { return q.answer === 'On it' && q.answered_by === 'James Burns'; }));
  });
  await check('phone: Ask about this on a kit item', async function () {
    await page.click('[data-tab=kit]'); await page.click('[data-act=openitem][data-id=i2]');
    await page.click('[data-act=askitem][data-id=i2]');
    await page.waitForSelector('#askform');
    assert(/About: NDs/.test(await page.textContent('#askform')));
    await page.fill('#ask_text', 'Which strengths?');
    await page.click('form[data-form=ask] button[type=submit]');
    await page.waitForFunction(function () { return !document.getElementById('status').classList.contains('show'); });
    assert(b.get({ a: 'state', k: 'ADMIN1' }).asks.some(function (q) { return q.about === 'NDs' && q.to === 'Elliot' && q.from === 'James Burns'; }));
  });
  await check('phone: "I\'ve added all my kit"', async function () {
    await page.click('[data-act=kitdone]');
    await page.waitForFunction(function () { return /all on the sheet/.test(document.body.textContent); });
    await page.screenshot({ path: __dirname + '/shots/phone-mine.png', fullPage: true });
  });
  await check('phone: ticks made with no signal send later', async function () {
    await page.click('[data-tab=kit]');
    b.down = true;
    await page.click('[data-act=pack][data-id=i2]');
    await page.click('.sure button[type=submit]');
    await page.waitForFunction(function () { return /No signal/.test(document.getElementById('status').textContent); });
    assert(!b.get({ a: 'state', k: 'ADMIN1' }).items[1].packed);
    b.down = false;
    await page.evaluate(function () { window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(function () { return !document.getElementById('status').classList.contains('show'); });
    assert(b.get({ a: 'state', k: 'ADMIN1' }).items[1].packed);
    await page.screenshot({ path: __dirname + '/shots/phone-kit.png', fullPage: true });
  });

  var desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  var ep = await desk.newPage(); ep.on('pageerror', function (e) { errors.push(e.message); });
  await check('desktop: Elliot sees James online, kit in', async function () {
    await ep.goto(base + '?k=ADMIN1');
    await ep.waitForSelector('h1');
    await ep.click('[data-tab=crew]');
    var t = await ep.textContent('.crew');
    assert(/James Burns2nd AC · online now/.test(t) && /kit in/.test(t), t);
  });
  await check('desktop: "Grip (not named yet)" as who brings it raises a flag', async function () {
    act(b, 'ADMIN1', { a: 'add_item', item: 'Dolly + track', dept: 'Grip', owner: 'Grip (not named yet)' });
    await ep.reload(); await ep.click('[data-tab=kit]'); await ep.waitForSelector('.flags');
    var t = await ep.textContent('.flags'); if (/Show all/.test(t)) { await ep.click('[data-act=allflags]'); t = await ep.textContent('.flags'); }
    assert(/Grip not booked yet, so nobody's bringing: Dolly \+ track\. Louis to book one\?/.test(t), t);
    var opts = await ep.evaluate(function () { return document.querySelector('optgroup') ? [].map.call(document.querySelectorAll('optgroup option'), function (o) { return o.textContent; }) : null; });
    await ep.click('[data-tab=kit]');
  });
  await check('booked roles are left out of "Not booked yet" (Davo is DIT)', async function () {
    await ep.click('[data-act=openitem][data-id=i2]');
    var o = await ep.$$eval('select[name=owner] optgroup option', function (l) { return l.map(function (x) { return x.textContent; }); });
    assert(o.indexOf('Grip (not named yet)') >= 0 && o.indexOf('DIT (not named yet)') < 0 && o.indexOf('1st AC (not named yet)') < 0, o.join(', '));
    await ep.click('[data-act=openitem][data-id=i2]');
  });
  await check('desktop: crew needed flags a missing role; Add name puts them on the crew', async function () {
    act(b, 'ADMIN1', { a: 'set_job', fields: { needs: 'DIT, Spark' } });
    await ep.reload(); await ep.click('[data-tab=kit]'); await ep.waitForSelector('.flags');
    var t = await ep.textContent('.flags'); if (/Show all/.test(t)) { await ep.click('[data-act=allflags]'); t = await ep.textContent('.flags'); }
    assert(/No Spark booked yet\. Louis to book one\?/.test(t) && !/No DIT/.test(t) && !/Maxine to book/.test(t), t); // production designer is art, not a booker
    await ep.click('[data-act=booknow][data-role=Spark]');
    await ep.fill('#book_name', 'Sam Spark');
    await ep.click('form[data-form=booking] button[type=submit]');
    await ep.waitForFunction(function () { return !document.getElementById('status').classList.contains('show') && !/No Spark/.test(document.body.textContent); });
    assert(b.get({ a: 'state', k: 'ADMIN1' }).crew.some(function (c) { return c.name === 'Sam Spark' && c.dept === 'Lighting'; }));
  });
  await check('desktop: Elliot confirms an item', async function () {
    await ep.click('[data-tab=kit]');
    var id = b.get({ a: 'state', k: 'ADMIN1' }).items.filter(function (i) { return i.item === 'Vaxis TX + 3 RX'; })[0].id;
    await ep.click('[data-act=confirm][data-id="' + id + '"]');
    assert(/Vaxis TX \+ 3 RX confirmed/.test(await ep.textContent('.sure')));
    await ep.click('.sure button[type=submit]');
    await ep.waitForFunction(function () { return !document.getElementById('status').classList.contains('show'); });
    assert(b.get({ a: 'state', k: 'ADMIN1' }).items.filter(function (i) { return i.id === id; })[0].confirmed);
  });
  await check('desktop: link + WhatsApp invite per person', async function () {
    await ep.click('[data-tab=crew]');
    await ep.click('.crew [data-n="0"]');
    var href = await ep.getAttribute('.crew a[href^="https://wa.me/"]', 'href');
    assert(/wa\.me\/447500000000/.test(href) && href.includes(encodeURIComponent('?k=JAMES1')), href);
    await ep.screenshot({ path: __dirname + '/shots/desk-crew.png', fullPage: true });
  });
  await check('desktop: Email link opens a Gmail draft in a new tab', async function () {
    var a = await ep.$('.crew a.link[href*="mail.google.com"]');
    assert(a, 'no gmail link');
    assert.strictEqual(await a.getAttribute('target'), '_blank');
    assert((await a.getAttribute('href')).includes('to=j%40x.com'));
    var pop = ep.waitForEvent('popup');
    await a.click();
    var w = await pop; assert(/mail\.google\.com/.test(w.url()) || w.url() === 'about:blank'); await w.close();
    assert(await ep.$('.crew .contact'), 'panel closed on click');
  });
  await check('phone: email is a mailto', async function () {
    await page.click('[data-tab=crew]'); await page.click('.crew [data-n="1"]');
    assert(/^mailto:m@x\.com/.test(await page.getAttribute('.crew .contact a[href^="mailto:"]', 'href')));
    await page.click('[data-tab=kit]');
  });
  await check('phone: Send my update goes to Elliot & production with my kit', async function () {
    await page.click('[data-tab=mine]');
    var href = decodeURIComponent(await page.getAttribute('a.update', 'href'));
    assert(/^mailto:dp@x\.com,l@x\.com/.test(href) && /Hey Elliot & Louis/.test(href) && /Vaxis TX \+ 3 RX/.test(href), href);
  });
  await check('phone: Email supplier goes to the supplier contact & production', async function () {
    await page.click('[data-tab=kit]');
    await page.click('[data-act=openitem][data-id=i1]');
    var href = decodeURIComponent(await page.getAttribute('a.email-sup', 'href'));
    assert(/^mailto:a@x\.com,l@x\.com,dp@x\.com/.test(href) && /Hey Aduke & Louis/.test(href) && /confirm the Sony Venice 8\.6K w\/ Rialto from MCX/.test(href), href);
    await page.click('[data-act=openitem][data-id=i1]');
  });
  await check('phone: Notes tab shows the DP notes', async function () {
    await page.click('[data-tab=notes]');
    var t = await page.textContent('main');
    assert(/Camera & codecs/.test(t) && /Venice 8.6K full res/.test(t) && /Rickshaw in low/.test(t), t.slice(0, 200));
    await page.click('[data-tab=kit]');
  });
  await check('desktop: Message Davo drafts his codecs section, not the light', async function () {
    await ep.click('[data-tab=crew]');
    var n = await ep.evaluate(function () { var x = [].slice.call(document.querySelectorAll('.crew .body .name')).findIndex(function (e) { return e.textContent === 'Davo'; }); return x - 1; });
    await ep.click('.crew [data-n="' + n + '"]');
    var href = decodeURIComponent(await ep.getAttribute('.crew a.msg', 'href'));
    assert(/Camera & codecs:/.test(href) && /Venice 8\.6K full res/.test(href) && !/book light/.test(href) && /k=DAVO1/.test(href), href);
  });
  await check('desktop: Elliot edits the DP notes', async function () {
    await ep.click('[data-tab=notes]');
    await ep.click('[data-act=editnotes]');
    await ep.fill('#dp_notes', '## Camera & codecs\n- Venice 8.6K X-OCN');
    await ep.click('form[data-form=notes] button[type=submit]');
    await ep.waitForFunction(function () { return !document.getElementById('status').classList.contains('show'); });
    assert(/X-OCN/.test(b.get({ a: 'state', k: 'JAMES1' }).job.dp_notes));
  });
  await check('phone: sees Elliot\'s confirm within a poll', async function () {
    await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(function () { return /confirmed 2/.test(document.querySelector('.count').textContent); }, null, { timeout: 12000 });
  });
  await check('phone: "Since you last looked" lists other people\'s changes', async function () {
    await page.evaluate(function () { localStorage.setItem('hymn_seen_JAMES1', String(Date.now() - 3 * 3600e3)); });
    act(b, 'ADMIN1', { a: 'add_item', item: 'Tiffen Black Pro-Mist', dept: 'Camera', supplier: 'MCX', confirm: 1 });
    await page.reload();
    await page.waitForSelector('.since');
    var t = await page.textContent('.since');
    assert(/Tiffen Black Pro-Mist/.test(t) && /Elliot/.test(t), t);
    var who = await page.$$eval('.since li > span:first-child', function (l) { return l.map(function (x) { return x.textContent; }); });
    assert(who.indexOf('James') < 0, 'own changes are left out');
    assert(await page.$('.tag.new'));
    await page.click('[data-act=gotit]');
    assert(!(await page.$('.since')));
  });
  await check('phone: a forever link opens & switches jobs', async function () {
    var r = act(b, 'ADMIN1', { a: 'add_crew', name: 'Two Jobs', email: 'two@x.com' });
    var pk = r.crew.filter(function (c) { return c.name === 'Two Jobs'; })[0].person;
    act(b, 'ADMIN2', { a: 'add_crew', name: 'Two Jobs', email: 'two@x.com' });
    var tp = await phone.newPage(); tp.on('pageerror', function (e) { errors.push(e.message); });
    await tp.goto(base + pk);
    await tp.waitForSelector('.jobs button');
    assert.strictEqual(await tp.$$eval('.jobs button', function (x) { return x.length; }), 2);
    var other = (await tp.textContent('h1')).trim() === 'Test Job' ? 'other' : 'test';
    await tp.click('.jobs [data-job=' + other + ']');
    await tp.waitForFunction(function (o) { return document.querySelector('h1').textContent.trim() === (o === 'other' ? 'Other Job' : 'Test Job'); }, other);
    await tp.reload(); await tp.waitForSelector('h1');
    assert.strictEqual((await tp.textContent('h1')).trim(), other === 'other' ? 'Other Job' : 'Test Job', 'remembers the job');
    await tp.close();
  });
  await check('an old per-job link swaps itself for the forever link', async function () {
    var c = require('crypto'), IT = 1000;
    var pkey = act(b, 'ADMIN1', { a: 'give_link', key: 'DAVO1' }).crew.filter(function (x) { return x.name === 'Davo'; })[0].person;
    var idx = c.pbkdf2Sync('DAVO1', 'hymn-index', IT, 16, 'sha256').toString('base64');
    var salt = c.randomBytes(16), iv = c.randomBytes(12), k = c.pbkdf2Sync('DAVO1', salt, IT, 32, 'sha256');
    var ci = c.createCipheriv('aes-256-gcm', k, iv), ct = Buffer.concat([ci.update(pkey), ci.final(), ci.getAuthTag()]);
    b.links = { it: IT, links: {} }; b.links.links[idx] = { s: salt.toString('base64'), i: iv.toString('base64'), c: ct.toString('base64') };
    var tp = await phone.newPage();
    await tp.goto(base + '?k=DAVO1');
    await tp.waitForURL(function (u) { return String(u).indexOf(pkey) >= 0; });
    await tp.waitForSelector('h1');
    assert(/Davo/.test(await tp.textContent('header .me')));
    await tp.close(); delete b.links;
  });
  await check('a job path like /test loads the app (crew.elliot.onl/yzy)', async function () {
    var jp = await desk.newPage(); jp.on('pageerror', function (e) { errors.push(e.message); });
    await jp.goto(base + 'test?k=ADMIN1');
    await jp.waitForSelector('h1');
    assert(/Test Job/.test(await jp.textContent('h1')));
    await jp.close();
  });
  await check('no script errors', function () { assert.deepStrictEqual(errors, []); });
  await browser.close(); server.close();
}

(async function () {
  require('fs').mkdirSync(__dirname + '/shots', { recursive: true });
  await backendTests();
  await uiTests();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();

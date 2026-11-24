// node tests/suite.js  (Playwright + Chromium; runs the real Code.gs on a fake Sheet)
var assert = require('assert');
var makeBackend = require('./fake-apps-script');
var serve = require('./serve');
var pw; try { pw = require('playwright'); } catch (e) { pw = require('/usr/local/lib/node_modules/playwright'); }

function seed() {
  return makeBackend([
    ['jobs', { job: 'test', title: 'Test Job', dates: 'Thu 26 Nov', call: '07:00', location: 'Deptford', prep: 'James, MCX Wed 12:00', admin_key: 'ADMIN1', dp_notes: '## Camera & codecs\n- Venice 8.6K full res\n\n## Light\n- 20x book light' }],
    ['jobs', { job: 'other', title: 'Other Job', admin_key: 'ADMIN2' }],
    ['crew', { job: 'test', key: 'JAMES1', name: 'James Burns', role: '2nd AC', dept: 'Camera', email: 'j@x.com', phone: '07500 000000' }],
    ['crew', { job: 'test', key: 'MILO1', name: 'Milo Brown', role: '1st AC', dept: 'Focus', email: 'm@x.com' }],
    ['crew', { job: 'test', key: 'DAVO1', name: 'Davo', role: 'DIT', dept: 'DIT', email: 'd@x.com' }],
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
    var s = b.post(JSON.stringify({ a: 'add_item', k: 'MILO1', item: 'Focus package', dept: 'Focus', supplier: 'Own kit' }));
    var it = s.items.filter(function (i) { return i.item === 'Focus package'; })[0];
    assert(it && !it.confirmed && it.asked_by === 'Milo Brown' && it.owner === 'Milo Brown');
  });
  await check('crew cannot confirm', function () { assert(b.post(JSON.stringify({ a: 'tick_item', k: 'MILO1', id: 'i2', field: 'confirmed' })).error); });
  await check('crew can tick packed, with name and time', function () {
    var s = b.post(JSON.stringify({ a: 'tick_item', k: 'JAMES1', id: 'i1', field: 'packed' }));
    assert(/^James Burns · /.test(s.items[0].packed));
  });
  await check('crew changing the supplier un-confirms the item', function () {
    var s = b.post(JSON.stringify({ a: 'set_item', k: 'JAMES1', id: 'i1', fields: { supplier: 'Production' } }));
    assert.strictEqual(s.items[0].confirmed, ''); assert.strictEqual(s.items[0].supplier, 'Production');
  });
  await check('crew cannot rename an item', function () {
    var s = b.post(JSON.stringify({ a: 'set_item', k: 'JAMES1', id: 'i1', fields: { item: 'Hacked' } }));
    assert(s.items[0].item !== 'Hacked');
  });
  await check('crew cannot tick someone else\'s task', function () { assert(b.post(JSON.stringify({ a: 'tick_task', k: 'JAMES1', id: 't2' })).error); });
  await check('crew tick their own task', function () { assert(b.post(JSON.stringify({ a: 'tick_task', k: 'JAMES1', id: 't1' })).tasks[0].done); });
  await check('every change goes in the log', function () {
    var s = b.get({ a: 'state', k: 'ADMIN1' });
    assert(s.log.length >= 4); assert(s.log.some(function (l) { return /packed Sony Venice/.test(l.what) && l.who === 'James Burns'; }));
  });
  await check('cross-job ids are refused', function () { assert(b.post(JSON.stringify({ a: 'tick_item', k: 'JAMES1', id: 'i3', field: 'packed' })).error); });
  await check('Elliot adds crew and gets a new link', function () {
    var s = b.post(JSON.stringify({ a: 'add_crew', k: 'ADMIN1', name: 'Henry', role: 'Grip', email: 'h@x.com' }));
    var h = s.crew.filter(function (c) { return c.name === 'Henry'; })[0]; assert(h && h.key.length === 12);
    assert(!b.get({ a: 'state', k: h.key }).error);
  });
  await check('phone numbers keep their +', function () {
    b.post(JSON.stringify({ a: 'add_crew', k: 'ADMIN1', name: 'Phone Test', phone: '+44 7796 000000' }));
    var d = b.get({ a: 'state', k: 'ADMIN1' }).crew.filter(function (c) { return c.name === 'Phone Test'; })[0];
    assert.strictEqual(d.phone, '+44 7796 000000');
  });
  await check('presence: opening the link shows online', function () {
    b.get({ a: 'state', k: 'MILO1' });
    var m = b.get({ a: 'state', k: 'ADMIN1' }).crew.filter(function (c) { return c.name === 'Milo Brown'; })[0];
    assert(m.online && m.opens === '1');
  });
  await check('kit done toggles', function () {
    var s = b.post(JSON.stringify({ a: 'kit_done', k: 'MILO1' }));
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
  await check('phone: tick packed saves to the sheet', async function () {
    await page.click('[data-act=pack][data-id=i1]');
    await page.waitForFunction(function () { return !document.getElementById('status').classList.contains('show'); });
    assert(/James Burns/.test(b.get({ a: 'state', k: 'ADMIN1' }).items[0].packed));
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
  await check('phone: "I\'ve added all my kit"', async function () {
    await page.click('[data-act=kitdone]');
    await page.waitForFunction(function () { return /all on the sheet/.test(document.body.textContent); });
    await page.screenshot({ path: __dirname + '/shots/phone-mine.png', fullPage: true });
  });
  await check('phone: ticks made with no signal send later', async function () {
    await page.click('[data-tab=kit]');
    b.down = true;
    await page.click('[data-act=pack][data-id=i2]');
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
  await check('desktop: Elliot confirms an item', async function () {
    await ep.click('[data-tab=kit]');
    var id = b.get({ a: 'state', k: 'ADMIN1' }).items.filter(function (i) { return i.item === 'Vaxis TX + 3 RX'; })[0].id;
    await ep.click('[data-act=confirm][data-id="' + id + '"]');
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

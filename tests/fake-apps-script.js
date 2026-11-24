// Runs backend/Code.gs in Node with a small in-memory stand-in for
// SpreadsheetApp, CacheService, LockService, Utilities and ContentService.
var fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');

function makeBackend(seed) {
  var tabs = {};
  function Sheet(name) { this.name = name; this.data = []; }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { return this.data.length; };
  Sheet.prototype.getLastColumn = function () { return Math.max.apply(null, [0].concat(this.data.map(function (r) { return r.length; }))); };
  Sheet.prototype.appendRow = function (r) { this.data.push(r.map(text)); };
  Sheet.prototype.deleteRow = function (n) { this.data.splice(n - 1, 1); };
  Sheet.prototype.getDataRange = function () { var d = this.data, w = this.getLastColumn(); return { getValues: function () { return d.map(function (r) { var c = r.slice(); while (c.length < w) c.push(''); return c; }); } }; };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    var d = this.data;
    return {
      getValues: function () { var out = []; for (var i = 0; i < (nr || 1); i++) { var row = []; for (var j = 0; j < (nc || 1); j++) row.push(((d[r - 1 + i] || [])[c - 1 + j]) === undefined ? '' : d[r - 1 + i][c - 1 + j]); out.push(row); } return out; },
      setValue: function (v) { while (d.length < r) d.push([]); d[r - 1][c - 1] = text(v); }
    };
  };
  function text(v) { return typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v; }
  var ss = {
    getSheetByName: function (n) { return tabs[n] || null; },
    insertSheet: function (n) { return (tabs[n] = new Sheet(n)); },
    getSheets: function () { return Object.keys(tabs).map(function (k) { return tabs[k]; }); }
  };
  var cache = {};
  var ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: function () { return ss; } },
    CacheService: { getScriptCache: function () { return { get: function (k) { return cache[k] || null; }, put: function (k, v) { cache[k] = v; } }; } },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    Utilities: {
      getUuid: function () { return crypto.randomUUID(); },
      formatDate: function (d, tz, f) { if (f === 'yyyy-MM-dd') return d.toISOString().slice(0, 10); var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return d.getDate() + ' ' + m[d.getMonth()] + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: function (s) { return { body: s, setMimeType: function () { return this; } }; } },
    JSON: JSON, Date: Date, Object: Object, String: String, Number: Number, Math: Math
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), ctx);
  // The live Sheet's tabs as they are today.
  var HEAD = {
    jobs:  ['job', 'title', 'dates', 'call', 'location', 'prep', 'deck', 'admin_key', 'notes', 'dp_notes'],
    crew:  ['job', 'key', 'name', 'role', 'dept', 'email', 'phone', 'kit_done', 'added'],
    items: ['id', 'job', 'dept', 'item', 'qty', 'supplier', 'asked_by', 'owner', 'confirmed', 'packed', 'notes', 'source', 'updated'],
    tasks: ['id', 'job', 'who', 'task', 'due', 'done', 'updated'],
    shots: ['job', 'no', 'shot', 'notes'],
    flags: ['id', 'job', 'text', 'status', 'source', 'raised_by', 'time'],
    log:   ['time', 'job', 'who', 'what'],
    seen:  ['job', 'key', 'name', 'first', 'last', 'opens']
  };
  Object.keys(HEAD).forEach(function (n) { ss.insertSheet(n).appendRow(HEAD[n]); });
  (seed || []).forEach(function (s) { tabs[s[0]].appendRow(HEAD[s[0]].map(function (h) { return s[1][h] === undefined ? '' : s[1][h]; })); });
  return {
    tabs: tabs, ctx: ctx,
    get: function (params) { return JSON.parse(ctx.doGet({ parameter: params }).body); },
    post: function (body) { return JSON.parse(ctx.doPost({ postData: { contents: body } }).body); }
  };
}

module.exports = makeBackend;

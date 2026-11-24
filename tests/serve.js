// Local test server: the page on /, the fake backend on /api.
var http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
module.exports = function serve(backend, port) {
  var root = path.join(__dirname, '..');
  var types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if (u.pathname === '/api') {
      if (backend.down) { res.writeHead(503); return res.end(); }
      var body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        var out = req.method === 'POST' ? backend.post(body) : backend.get(u.query);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (u.pathname === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.HYMN_API = '/api'; window.HYMN_DP_EMAIL = 'dp@x.com';"); }
    var f = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(function (ok) { server.listen(port || 0, function () { ok(server); }); });
};

const http = require('http');
const orig = http.createServer;
http.createServer = function (...a) {
  const h = a.pop();
  return orig.call(this, ...a, (req, res) => {
    const p = process.env.APP_PASSWORD;
    if (!p) { res.writeHead(500); return res.end('APP_PASSWORD not set'); }
    const got = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString();
    if (got.slice(got.indexOf(':') + 1) !== p) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Leads"' });
      return res.end('Login required');
    }
    h(req, res);
  });
};

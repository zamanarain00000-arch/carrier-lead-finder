const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { db, CARGO, scoreOf } = require('./lib/db');
const STATUSES = ['new', 'called', 'interested', 'callback', 'not_interested'];

function where(q) {
  const w = ['stale=0'], a = [];
  if (q.state) { w.push('state=?'); a.push(q.state.toUpperCase()); }
  if (q.cargo && CARGO[q.cargo]) { w.push('cargo LIKE ?'); a.push(`%,${q.cargo},%`); }
  if (+q.minPower) { w.push('power_units>=?'); a.push(+q.minPower); }
  if (+q.minDrivers) { w.push('drivers>=?'); a.push(+q.minDrivers); }
  if (q.q) { const t = q.q.trim(), d = t.replace(/\D/g, ''); w.push('(name_norm LIKE ? OR dot=? OR mc LIKE ?)'); a.push(`%${t.toUpperCase().replace(/[^A-Z0-9 ]/g, '')}%`, d, `%${d || '~'}%`); }
  if (STATUSES.includes(q.status)) { w.push('lead_status=?'); a.push(q.status); }
  if (q.queue) w.push("lead_status IN ('new','callback')");
  const order = q.queue ? "CASE WHEN lead_status='callback' AND callback_at<=? THEN 0 ELSE 1 END, score DESC, id" : 'score DESC, id';
  if (q.queue) a.push(new Date().toISOString()); // order param comes after where params
  return { sql: ' WHERE ' + w.join(' AND '), a, order };
}
const decorate = r => ({ ...r, cargo_labels: r.cargo.split(',').filter(Boolean).map(k => CARGO[k].label), breakdown: scoreOf(r).parts });
const csvCell = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

function api(req, res, u) {
  const q = Object.fromEntries(u.searchParams), json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/meta') return json({
    states: db.prepare('SELECT state,COUNT(*) n FROM carriers WHERE stale=0 GROUP BY state ORDER BY state').all(),
    cargo: Object.entries(CARGO).map(([k, v]) => ({ key: k, label: v.label })),
    total: db.prepare('SELECT COUNT(*) n FROM carriers WHERE stale=0').get().n,
    lastImport: db.prepare('SELECT * FROM imports ORDER BY started DESC LIMIT 1').get() || null });
  if (u.pathname === '/api/leads' && req.method === 'GET') {
    const W = where(q), limit = [25, 50, 100].includes(+q.limit) ? +q.limit : 25, off = Math.max(0, +q.offset || 0);
    const total = db.prepare('SELECT COUNT(*) n FROM carriers' + W.sql).get(...W.a.slice(0, q.queue ? -1 : undefined)).n;
    const rows = db.prepare(`SELECT * FROM carriers${W.sql} ORDER BY ${W.order} LIMIT ? OFFSET ?`).all(...W.a, limit, off);
    return json({ total, limit, offset: off, rows: rows.map(decorate) });
  }
  if (u.pathname === '/api/export.csv') {
    const W = where(q), rows = db.prepare(`SELECT * FROM carriers${W.sql} ORDER BY ${W.order} LIMIT 50000`).all(...W.a);
    const H = ['Company', 'Phone', 'USDOT', 'MC/MX', 'City', 'State', 'Truck Type (FMCSA cargo)', 'Power Units', 'Drivers', 'Status', 'Lead Score', 'Source'];
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="leads.csv"' });
    return res.end([H.join(','), ...rows.map(r => [r.name, r.phone, r.dot, r.mc, r.city, r.state, decorate(r).cargo_labels.join('; '), r.power_units, r.drivers, r.lead_status, r.score, r.source].map(csvCell).join(','))].join('\n'));
  }
  const m = u.pathname.match(/^\/api\/leads\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      try {
        const p = JSON.parse(b || '{}'), sets = [], a = [];
        if (p.status) { if (!STATUSES.includes(p.status)) return json({ error: 'bad status' }, 400); sets.push('lead_status=?'); a.push(p.status); if (p.status === 'called') sets.push("called_at=datetime('now')"); }
        if ('notes' in p) { sets.push('notes=?'); a.push(String(p.notes).slice(0, 5000)); }
        if ('callback_at' in p) { sets.push('callback_at=?'); a.push(p.callback_at || null); }
        if (!sets.length) return json({ error: 'nothing to update' }, 400);
        const r = db.prepare(`UPDATE carriers SET ${sets.join(',')} WHERE id=?`).run(...a, +m[1]);
        json({ ok: r.changes === 1 });
      } catch (e) { json({ error: e.message }, 400); }
    }); return;
  }
  json({ error: 'not found' }, 404);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { try { return api(req, res, u); } catch (e) { res.writeHead(500); return res.end(String(e)); } }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));

const hrs = +process.env.AUTO_IMPORT_HOURS;
if (hrs > 0) setInterval(() => spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, 'scripts/import.js')], { stdio: 'inherit' }), hrs * 3600e3);

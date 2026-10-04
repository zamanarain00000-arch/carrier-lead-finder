// Usage: npm run import            (downloads FMCSA Company Census File, then imports)
//        npm run import -- --file path/to/census.csv [--no-stale]
const fs = require('fs'), path = require('path'), { Readable } = require('stream'), { pipeline } = require('stream/promises');
const { db, CARGO, normPhone, normName, normStreet, normState, pretty, isTest, scoreOf } = require('../lib/db');
const URL_ = process.env.CENSUS_URL || 'https://data.transportation.gov/api/views/az4n-8mr2/rows.csv?accessType=DOWNLOAD';
const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1] || true; };

async function* csvRows(stream) {
  stream.setEncoding('utf8'); let f = '', row = [], q = false, pend = false, first = true;
  for await (let chunk of stream) {
    if (first) { chunk = chunk.replace(/^\uFEFF/, ''); first = false; }
    for (const ch of chunk) {
      if (pend) { pend = false; if (ch === '"') { f += '"'; continue; } q = false; }
      if (q) { if (ch === '"') pend = true; else f += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n') { row.push(f); f = ''; yield row; row = []; }
      else if (ch !== '\r') f += ch;
    }
  }
  if (f || row.length) { row.push(f); yield row; }
}

const S = {
  find: db.prepare('SELECT * FROM carriers WHERE dot=? OR phone=? OR (nkey IS NOT NULL AND nkey=?)'),
  del: db.prepare('DELETE FROM carriers WHERE id=?'),
  touch: db.prepare('UPDATE carriers SET run_id=?, stale=0 WHERE id=?'),
  ins: db.prepare(`INSERT INTO carriers(dot,mc,name,name_norm,phone,nkey,address,city,state,zip,cargo,power_units,drivers,email,carrier_status,source,source_updated,imported_at,run_id,score,lead_status,notes,callback_at,called_at)
   VALUES(:dot,:mc,:name,:name_norm,:phone,:nkey,:address,:city,:state,:zip,:cargo,:power_units,:drivers,:email,:carrier_status,:source,:source_updated,:imported_at,:run_id,:score,:lead_status,:notes,:callback_at,:called_at)`),
  upd: db.prepare(`UPDATE carriers SET mc=:mc,name=:name,name_norm=:name_norm,phone=:phone,nkey=:nkey,address=:address,city=:city,state=:state,zip=:zip,cargo=:cargo,
   power_units=:power_units,drivers=:drivers,email=:email,carrier_status=:carrier_status,source=:source,source_updated=:source_updated,imported_at=:imported_at,run_id=:run_id,stale=0,score=:score WHERE id=:id`),
};
const blank = { lead_status: 'new', notes: '', callback_at: null, called_at: null };

// Dedup on USDOT, normalized phone, normalized name+address. Returns i=inserted, u=updated, d=duplicate resolved.
function upsert(c) {
  const ex = S.find.all(c.dot, c.phone, c.nkey);
  if (!ex.length) { S.ins.run({ ...c, ...blank }); return 'i'; }
  const same = ex.find(r => r.dot === c.dot);
  if (same) {                      // same USDOT = same carrier: update in place, keep call status/notes
    ex.filter(r => r !== same).forEach(r => S.del.run(r.id));
    { const { dot, ...rest } = c; S.upd.run({ ...rest, id: same.id }); } return 'u';
  }
  if (ex.every(r => r.score >= c.score)) { ex.forEach(r => S.touch.run(c.run_id, r.id)); return 'd'; } // keep better existing
  const carry = ex.find(r => r.lead_status !== 'new') || blank;            // new one is better: replace, keep progress
  ex.forEach(r => S.del.run(r.id));
  S.ins.run({ ...c, lead_status: carry.lead_status, notes: carry.notes, callback_at: carry.callback_at, called_at: carry.called_at });
  return 'd';
}

(async () => {
  let file = arg('--file');
  if (!file || file === true) {
    file = path.join(__dirname, '..', 'data', 'census.csv');
    console.log('Downloading', URL_);
    const res = await fetch(URL_, { headers: { 'User-Agent': 'carrier-lead-finder/1.0' } });
    if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  }
  const run = new Date().toISOString(), src = 'FMCSA Company Census File (data.transportation.gov)';
  const st = { rows: 0, i: 0, u: 0, d: 0, skip: 0 };
  let H = null; db.exec('BEGIN');
  for await (const r of csvRows(fs.createReadStream(file))) {
    if (!H) { H = {}; r.forEach((h, i) => H[h.trim().toUpperCase()] = i); continue; }
    const g = k => (H[k] === undefined ? '' : (r[H[k]] || '').trim());
    st.rows++;
    const status = g('STATUS_CODE') || 'A';
    const name = pretty(g('LEGAL_NAME') || g('DBA_NAME')), dot = g('DOT_NUMBER').replace(/\D/g, '');
    const phone = normPhone(g('PHONE')) || normPhone(g('CELL_PHONE')), state = normState(g('PHY_STATE'));
    if (status !== 'A' || !dot || !phone || !name || isTest(name) || !state) { st.skip++; continue; }
    const cargo = Object.keys(CARGO).filter(k => CARGO[k].cols.some(c => /^(X|Y|1|TRUE)$/i.test(g(c))));
    const zip = g('PHY_ZIP').slice(0, 5), street = normStreet(g('PHY_STREET'));
    const pre = g('DOCKET1PREFIX').toUpperCase(), mc = (pre === 'MC' || pre === 'MX') && g('DOCKET1') ? pre + '-' + g('DOCKET1') : null;
    const c = { dot, mc, name, name_norm: normName(name), phone, address: pretty(g('PHY_STREET')), city: pretty(g('PHY_CITY')), state, zip,
      cargo: cargo.length ? ',' + cargo.join(',') + ',' : '', power_units: parseInt(g('NBR_POWER_UNIT')) || 0, drivers: parseInt(g('DRIVER_TOTAL')) || 0,
      email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g('EMAIL_ADDRESS')) ? g('EMAIL_ADDRESS').toLowerCase() : null,
      carrier_status: status, source: src, source_updated: g('MCS150_DATE') || null, imported_at: run, run_id: run };
    c.nkey = street ? `${c.name_norm}|${street}|${zip}` : null;
    c.score = scoreOf(c).score;
    st[upsert(c)]++;
    if (st.rows % 20000 === 0) { db.exec('COMMIT; BEGIN'); console.log(st.rows, 'rows...'); }
  }
  db.exec('COMMIT');
  let stale = 0;  // records not in this full import are hidden (stale=1), not deleted, so call history survives
  if (st.rows > 0 && !args.includes('--no-stale')) stale = db.prepare('UPDATE carriers SET stale=1 WHERE run_id<>?').run(run).changes;
  db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?)').run(run, run, new Date().toISOString(), st.rows, st.i, st.u, st.skip, st.d);
  console.log(`Done. read=${st.rows} inserted=${st.i} updated=${st.u} skipped=${st.skip} duplicates-resolved=${st.d} marked-stale=${stale}`);
})().catch(e => { try { db.exec('ROLLBACK'); } catch {} console.error(e); process.exit(1); });

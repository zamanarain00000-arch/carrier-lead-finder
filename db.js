const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'leads.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS carriers(
 id INTEGER PRIMARY KEY, dot TEXT NOT NULL UNIQUE, mc TEXT, name TEXT NOT NULL, name_norm TEXT,
 phone TEXT NOT NULL UNIQUE,            -- 10-digit normalized; UNIQUE = same phone can never appear twice
 nkey TEXT UNIQUE,                      -- normalized name|street|zip dedup key
 address TEXT, city TEXT, state TEXT, zip TEXT, cargo TEXT DEFAULT '',
 power_units INTEGER DEFAULT 0, drivers INTEGER DEFAULT 0, email TEXT, website TEXT,
 carrier_status TEXT, source TEXT, source_updated TEXT, imported_at TEXT, run_id TEXT,
 stale INTEGER DEFAULT 0, score INTEGER DEFAULT 0,
 lead_status TEXT DEFAULT 'new', notes TEXT DEFAULT '', callback_at TEXT, called_at TEXT);
CREATE INDEX IF NOT EXISTS ix_f ON carriers(state,stale,lead_status);
CREATE TABLE IF NOT EXISTS imports(run_id TEXT PRIMARY KEY, started TEXT, finished TEXT,
 rows_read INT, inserted INT, updated INT, skipped INT, dupes INT);`);

// Only categories FMCSA actually reports (cargo-carried flags). Equipment types (dry van, reefer...) are NOT in the dataset.
const CARGO = {
  general_freight: { label: 'General Freight', cols: ['CRGO_GENFREIGHT'] },
  refrigerated_food: { label: 'Refrigerated Food', cols: ['CRGO_COLDFOOD'] },
  fresh_produce: { label: 'Fresh Produce', cols: ['CRGO_PRODUCE'] },
  machinery: { label: 'Machinery / Large Objects', cols: ['CRGO_MACHLRG'] },
  building_materials: { label: 'Building Materials', cols: ['CRGO_BLDGMAT'] },
  motor_vehicles: { label: 'Motor Vehicles', cols: ['CRGO_MOTOVEH'] },
  intermodal: { label: 'Intermodal Containers', cols: ['CRGO_INTERMOD'] },
  agricultural: { label: 'Agricultural (grain/feed, farm supplies, livestock)', cols: ['CRGO_GRAINFEED', 'CRGO_FARMSUPP', 'CRGO_LIVESTOCK'] },
  construction: { label: 'Construction', cols: ['CRGO_CONSTRUCT'] },
};
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));

function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d) || /^[01]/.test(d.slice(3)) || /^(\d)\1{9}$/.test(d) || d === '1234567890') return null;
  if (d.slice(3, 6) === '555' && d[6] === '0' && d[7] === '1') return null; // fictional 555-01xx
  return d;
}
const SUF = /\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP)\b/g;
const normName = s => String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').replace(SUF, ' ').replace(/\s+/g, ' ').trim();
const normStreet = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\bSTREET\b/g, 'ST').replace(/\bROAD\b/g, 'RD').replace(/\bAVENUE\b/g, 'AVE').replace(/\bSUITE\b/g, 'STE').replace(/\s+/g, ' ').trim();
const normState = s => { s = String(s || '').trim().toUpperCase(); return STATES.has(s) ? s : null; };
const pretty = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Llc|Inc|Lp|Llp|Usa|Us|Dba)\b/g, m => m.toUpperCase());
const isTest = n => /\b(TEST|DUMMY|SAMPLE|FAKE|DO NOT USE|UNKNOWN)\b/i.test(n) || n.replace(/[^A-Za-z]/g, '').length < 2;

function scoreOf(c) {
  const parts = [
    ['Valid business phone number', 25, !!c.phone],
    ['Active carrier status in FMCSA data', 15, c.carrier_status === 'A'],
    ['2+ power units', 15, c.power_units >= 2],
    ['10+ power units', 10, c.power_units >= 10],
    ['2+ drivers', 10, c.drivers >= 2],
    ['Cargo classification reported', 15, !!c.cargo],
    ['Complete info (street address + public email)', 10, !!(c.address && c.email)],
  ].map(([label, pts, ok]) => ({ label, pts, ok }));
  return { score: parts.reduce((s, p) => s + (p.ok ? p.pts : 0), 0), parts };
}
module.exports = { db, CARGO, normPhone, normName, normStreet, normState, pretty, isTest, scoreOf };

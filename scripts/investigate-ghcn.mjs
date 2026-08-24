/* =============================================================================
   Can NOAA station observations carry the dashboard?

   The hot-day investigation showed the reanalysis is not slightly off on
   threshold counts, it is wrong: two of three homes are out by more than a
   factor of two. Station records are right by construction — they ARE the
   measurements. The question is whether they carry enough: a station reports
   what its instruments record, and if it has no sunshine sensor then no amount
   of wanting one produces sunny-day counts.

   So this inventories what each candidate station actually provides across the
   window, then builds the same monthly aggregates the dashboard publishes and
   puts them next to what is published today.

   Run: node scripts/investigate-ghcn.mjs [--out FILE]
   =========================================================================== */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const cfg = require(path.join(ROOT, 'js/config.js'));

const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const outPath = path.resolve(ROOT, argOf('--out', 'data/ghcn-investigation.json'));
const PERIOD = argOf('--period', cfg.DEFAULT_PERIOD);
const P = cfg.PERIODS[PERIOD];
const START = P.start, END = P.end;
const log = (...m) => console.log(...m);

/* Every element the dashboard would want from a thermometer site. Asking for
   all of them and seeing what comes back is the inventory. */
const WANT = ['TMAX', 'TMIN', 'TAVG', 'PRCP', 'SNOW', 'SNWD', 'AWND', 'WSF2', 'WSF5', 'WDF2', 'TSUN', 'PSUN'];

/* Ids corrected 2026-08: rockaway led with USW00054785, which is Somerset
   and not the Morristown it was labelled, and bonita with USW00012895, which
   is Fort Pierce on the other coast. The third Rockaway slot was Moorestown,
   68 miles south; it is now the CoCoRaHS gauge 0.2 miles from the house,
   which is the only nearby site with a snow board. */
const STATIONS = {
  rockaway: ['USW00054743', 'USW00014734', 'US1NJMS0006'],
  nmb:      ['USW00093718', 'USW00013717', 'USC00386153'],
  bonita:   ['USW00012897', 'USW00012835', 'USC00080611']
};

async function daily(stationId) {
  const url = 'https://www.ncei.noaa.gov/access/services/data/v1'
    + `?dataset=daily-summaries&stations=${stationId}`
    + `&startDate=${START}&endDate=${END}&format=json&units=standard`
    + `&dataTypes=${WANT.join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tri-state-weather-dashboard (investigation)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows');
  return rows;
}

const expectedDays = Math.round((new Date(END) - new Date(START)) / 86400000) + 1;
const report = { generated: new Date().toISOString(), period: PERIOD, window: `${START}…${END}`, homes: {} };

/* What the dashboard publishes today, for the side-by-side. */
let published = null;
try { published = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/climate.json'), 'utf8')); } catch (_) {}

for (const loc of cfg.LOCATIONS) {
  log(`\n\x1b[1m${loc.name}, ${loc.state}\x1b[0m`);
  const entry = { name: `${loc.name}, ${loc.state}`, stations: [] };

  for (const id of STATIONS[loc.id] || []) {
    let rows;
    try { rows = await daily(id); }
    catch (e) { log(`  ${id}: unusable (${e.message})`); continue; }

    const have = {}, name = rows.find(r => r.NAME)?.NAME || id;
    for (const el of WANT) have[el] = rows.filter(r => {
      const v = parseFloat(r[el]); return Number.isFinite(v) && v > -900;
    }).length;

    /* The aggregates the page actually shows, built the same way. */
    const yrs = new Set(rows.map(r => r.DATE.slice(0, 4)));
    const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > -900 ? n : null; };
    let hot90 = 0, hot95 = 0, freeze32 = 0, precip = 0, snow = 0;
    const mo = Array.from({ length: 12 }, () => ({ hi: [], lo: [], pr: 0, sn: 0 }));
    for (const r of rows) {
      const m = +r.DATE.slice(5, 7) - 1;
      const hi = num(r.TMAX), lo = num(r.TMIN), pr = num(r.PRCP), sn = num(r.SNOW);
      if (hi != null) { mo[m].hi.push(hi); if (hi >= 90) hot90++; if (hi >= 95) hot95++; }
      if (lo != null) { mo[m].lo.push(lo); if (lo <= 32) freeze32++; }
      if (pr != null) { mo[m].pr += pr; precip += pr; }
      if (sn != null) { mo[m].sn += sn; snow += sn; }
    }
    const y = yrs.size || 1;
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const st = {
      id, name, years: y,
      coverage: Object.fromEntries(Object.entries(have).map(([k, v]) => [k, +(v / expectedDays).toFixed(3)])),
      julHigh: mean(mo[6].hi), janHigh: mean(mo[0].hi), janLow: mean(mo[0].lo), julLow: mean(mo[6].lo),
      hot90: hot90 / y, hot95: hot95 / y, freeze32: freeze32 / y,
      annualPrecip: precip / y, annualSnow: snow / y
    };
    entry.stations.push(st);

    const pct = el => `${el} ${Math.round(st.coverage[el] * 100)}%`;
    log(`  ${id} — ${name}`);
    log(`    coverage: ${WANT.map(pct).join('  ')}`);
    log(`    JulHigh ${st.julHigh?.toFixed(1)}  JanHigh ${st.janHigh?.toFixed(1)}  JanLow ${st.janLow?.toFixed(1)}`
      + `  ≥90 ${st.hot90.toFixed(0)}  ≤32 ${st.freeze32.toFixed(0)}  precip ${st.annualPrecip.toFixed(1)}"  snow ${st.annualSnow.toFixed(1)}"`);
  }

  const pub = published?.homes?.[loc.id]?.[PERIOD];
  if (pub) {
    entry.published = {
      julHigh: pub.rows[6].avgHigh, janHigh: pub.rows[0].avgHigh, janLow: pub.rows[0].avgLow,
      hot90: pub.annual.annualHot90, freeze32: pub.annual.annualFreeze,
      annualPrecip: pub.annual.annualPrecip, annualSnow: pub.annual.annualSnow
    };
    const p = entry.published;
    log(`    \x1b[33mpublished (era5)\x1b[0m`);
    log(`    JulHigh ${p.julHigh?.toFixed(1)}  JanHigh ${p.janHigh?.toFixed(1)}  JanLow ${p.janLow?.toFixed(1)}`
      + `  ≥90 ${p.hot90?.toFixed(0)}  ≤32 ${p.freeze32?.toFixed(0)}  precip ${p.annualPrecip?.toFixed(1)}"  snow ${p.annualSnow?.toFixed(1)}"`);
  }
  report.homes[loc.id] = entry;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
log(`\nWrote ${path.relative(ROOT, outPath)}\n`);

#!/usr/bin/env node
/* =============================================================================
   validate-climate.mjs — check the reanalysis against ground truth.

   The first build had North Myrtle Beach at an 86°F July high and 6 days a year
   over 90°F, against published values nearer 89°F and 20–30 days. ERA5 runs on
   a ~28 km grid, so a coastal cell mixes land and sea and pulls summer maxima
   down. Rather than assume ERA5-Land fixes it, this measures it.

   Three sources, compared like-for-like over the SAME 1991–2020 window so that
   model bias is isolated from the real warming between periods:

     1. NOAA NCEI monthly normals 1991–2020 — gauge observations, ground truth
     2. Open-Meteo archive, model era5      — ~28 km
     3. Open-Meteo archive, model era5_land — ~9 km, land only

   Only three daily variables are pulled, so the whole check costs roughly 1,400
   weighted Open-Meteo calls — a fraction of a normals build.

   Writes data/validation.json, which the dashboard reads to show its own
   accuracy rather than claiming it.

   Usage: node scripts/validate-climate.mjs [--home nmb] [--out data/validation.json]
   =========================================================================== */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = require(path.join(ROOT, 'js/config.js'));
Object.assign(globalThis, {
  LOCATIONS: cfg.LOCATIONS, PERIODS: cfg.PERIODS, SST_PERIOD: cfg.SST_PERIOD,
  MONTHS: cfg.MONTHS, MONTHS_FULL: cfg.MONTHS_FULL, DEFAULT_PERIOD: cfg.DEFAULT_PERIOD
});
const api = require(path.join(ROOT, 'js/api.js'));

const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const onlyHome = argOf('--home', null);
const outPath = path.resolve(ROOT, argOf('--out', 'data/validation.json'));
const homes = cfg.LOCATIONS.filter(l => !onlyHome || l.id === onlyHome);

const REF_START = '1991-01-01', REF_END = '2020-12-31';
const log = (...m) => console.log(...m);

/* Candidate NOAA stations per home, nearest first. The script uses the first
   that actually returns normals and reports which, so a wrong guess shows up
   in the output instead of silently skewing the comparison.

   "Shows up in the output" is weaker than it sounds, which is why this list
   was wrong in three places until 2026-08: bonita led with Fort Pierce, 118
   miles away on the Atlantic coast, and fell back to Fort Lauderdale, also on
   the wrong coast; rockaway fell back to Moorestown, 68 miles south and named
   one letter away from the Morristown someone meant. A validation station in
   the wrong climate does not produce an obvious error — it produces a model
   bias figure that is quietly about somewhere else. Every id here is now the
   one used for the observations in scripts/stations.mjs, whose coordinates are
   checked against NOAA's at build time. */
const STATIONS = {
  /* Myrtle Beach AFB carries no 1991-2020 normals, so this falls through to
     the co-op site 9 miles inland; Grand Strand, 2 miles away, does carry
     them. Left in that order deliberately — the published comparison is
     against the co-op record and changing which station it names is a
     separate decision from fixing an id that pointed at the wrong state. */
  nmb:      ['USW00013717', 'USC00386153', 'USW00093718'],   // Myrtle Beach area
  bonita:   ['USW00012897', 'USW00012894', 'USW00012835'],   // Naples / Fort Myers
  /* Boonton first, because it is the station the published temperatures are
     now taken from — comparing the model against a different site than the one
     the page reports would measure the wrong gap. */
  rockaway: ['USC00280907', 'USW00054743', 'USW00014734']    // Boonton / Caldwell / Newark
};

/* --- NOAA NCEI monthly normals ------------------------------------------ */
async function noaaNormals(stationId) {
  const url = 'https://www.ncei.noaa.gov/access/services/data/v1'
    + `?dataset=normals-monthly-1991-2020&stations=${stationId}`
    + '&startDate=0001-01-01&endDate=9996-12-31&format=json&units=standard'
    + '&dataTypes=MLY-TMAX-NORMAL,MLY-TMIN-NORMAL,MLY-PRCP-NORMAL';
  const res = await fetch(url, { headers: { 'User-Agent': 'tri-state-weather-dashboard (validation)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows');

  const out = Array.from({ length: 12 }, () => ({ tmax: null, tmin: null, prcp: null }));
  let name = stationId;
  for (const r of rows) {
    /* The normals carry a pseudo-date; only the month is meaningful. */
    const m = +String(r.DATE || '').slice(-2) - 1;
    if (!(m >= 0 && m < 12)) continue;
    if (r.STATION_NAME || r.NAME) name = r.STATION_NAME || r.NAME;
    const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > -900 ? n : null; };
    if (out[m].tmax == null) out[m].tmax = num(r['MLY-TMAX-NORMAL']);
    if (out[m].tmin == null) out[m].tmin = num(r['MLY-TMIN-NORMAL']);
    if (out[m].prcp == null) out[m].prcp = num(r['MLY-PRCP-NORMAL']);
  }
  const filled = out.filter(o => o.tmax != null).length;
  if (filled < 12) throw new Error(`only ${filled}/12 months returned`);
  return { stationId, name, months: out };
}

async function firstWorkingStation(homeId) {
  for (const id of STATIONS[homeId] || []) {
    try {
      const r = await noaaNormals(id);
      log(`    NOAA station ${id} — ${r.name}`);
      return r;
    } catch (err) {
      log(`    NOAA station ${id} unusable (${err.message})`);
    }
  }
  return null;
}

/* --- Open-Meteo archive under one named model --------------------------- */
async function modelMonthly(loc, model) {
  const vars = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'];
  const url = `${api.API.archive}?latitude=${loc.lat}&longitude=${loc.lon}&timezone=${loc.tz}`
    + `&start_date=${REF_START}&end_date=${REF_END}&daily=${vars.join(',')}`
    + '&temperature_unit=fahrenheit&precipitation_unit=inch'
    + (model ? `&models=${model}` : '');
  const j = await api.apiGet(url, { label: `Archive 1991–2020 [${model || 'default'}] — ${loc.name}`, timeout: 90000 });
  const d = j.daily || {};
  const acc = Array.from({ length: 12 }, () => ({ hi: 0, hiN: 0, lo: 0, loN: 0, pr: 0, prYears: new Set(), prSum: new Map() }));
  (d.time || []).forEach((t, i) => {
    const m = +t.slice(5, 7) - 1, y = +t.slice(0, 4);
    if (!(m >= 0 && m < 12)) return;
    const hi = d.temperature_2m_max?.[i], lo = d.temperature_2m_min?.[i], pr = d.precipitation_sum?.[i];
    if (Number.isFinite(hi)) { acc[m].hi += hi; acc[m].hiN++; }
    if (Number.isFinite(lo)) { acc[m].lo += lo; acc[m].loN++; }
    if (Number.isFinite(pr)) {
      const key = `${y}`;
      acc[m].prSum.set(key, (acc[m].prSum.get(key) || 0) + pr);
      acc[m].prYears.add(key);
    }
  });
  return acc.map(a => ({
    tmax: a.hiN ? a.hi / a.hiN : null,
    tmin: a.loN ? a.lo / a.loN : null,
    /* Monthly precipitation totals averaged across years, matching how NOAA
       defines a precipitation normal. */
    prcp: a.prYears.size ? [...a.prSum.values()].reduce((s, v) => s + v, 0) / a.prYears.size : null
  }));
}

/* --- run ----------------------------------------------------------------- */
api.setPacing(6000);   // ~1,400 weighted calls over the whole run; well inside the caps

const report = {
  generated: new Date().toISOString(),
  window: `${REF_START.slice(0, 4)}–${REF_END.slice(0, 4)}`,
  note: 'ERA5 and ERA5-Land compared against NOAA NCEI 1991-2020 monthly normals over the identical window, so model bias is isolated from period-to-period warming.',
  homes: {}
};

const bias = (ours, ref) => {
  const pairs = ours.map((o, i) => [o, ref[i]]).filter(([o, r]) => o != null && r != null);
  if (!pairs.length) return null;
  const diffs = pairs.map(([o, r]) => o - r);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const absMax = diffs.reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, 0);
  return { meanBias: +mean.toFixed(2), worstMonth: MONTHS[diffs.indexOf(absMax)], worstBias: +absMax.toFixed(2), n: diffs.length };
};

for (const loc of homes) {
  log(`\n${loc.name}, ${loc.state}`);
  const entry = { name: `${loc.name}, ${loc.state}`, noaa: null, models: {}, verdict: null };

  log('  fetching NOAA normals…');
  const noaa = await firstWorkingStation(loc.id);
  if (noaa) entry.noaa = { stationId: noaa.stationId, name: noaa.name, months: noaa.months };
  else log('    no NOAA station returned usable normals — model comparison only');

  for (const model of ['era5', 'era5_land']) {
    log(`  fetching Open-Meteo [${model}]…`);
    try {
      const months = await modelMonthly(loc, model);
      entry.models[model] = { months };
      if (noaa) {
        entry.models[model].vsNoaa = {
          tmax: bias(months.map(m => m.tmax), noaa.months.map(m => m.tmax)),
          tmin: bias(months.map(m => m.tmin), noaa.months.map(m => m.tmin)),
          prcp: bias(months.map(m => m.prcp), noaa.months.map(m => m.prcp))
        };
      }
    } catch (err) {
      log(`    [${model}] failed: ${err.message}`);
      entry.models[model] = { error: String(err.message || err) };
    }
  }

  /* Which model sits closer to the gauges on summer maxima — the measure the
     coastal grid problem actually shows up in. */
  const a = entry.models.era5?.vsNoaa?.tmax, b = entry.models.era5_land?.vsNoaa?.tmax;
  if (a && b) {
    entry.verdict = Math.abs(b.meanBias) < Math.abs(a.meanBias) ? 'era5_land' : 'era5';
    log(`  → era5 tmax bias ${a.meanBias >= 0 ? '+' : ''}${a.meanBias}°F · era5_land ${b.meanBias >= 0 ? '+' : ''}${b.meanBias}°F  → ${entry.verdict} is closer`);
  }
  report.homes[loc.id] = entry;
}

/* --- print the table ----------------------------------------------------- */
log('\n' + '='.repeat(78));
log('July check — the month where the coastal grid problem shows up');
log('='.repeat(78));
log('home                 NOAA    era5   Δ      era5_land  Δ');
for (const [id, e] of Object.entries(report.homes)) {
  const n = e.noaa?.months?.[6]?.tmax;
  const a = e.models.era5?.months?.[6]?.tmax;
  const b = e.models.era5_land?.months?.[6]?.tmax;
  const f = (v, d = 1) => v == null ? '  —  ' : v.toFixed(d).padStart(5);
  const dl = (v, r) => (v == null || r == null) ? '     ' : ((v - r >= 0 ? '+' : '') + (v - r).toFixed(1)).padStart(5);
  log(`${(e.name || id).padEnd(20)} ${f(n)}  ${f(a)} ${dl(a, n)}   ${f(b)}   ${dl(b, n)}`);
}

log('\nMean bias across all 12 months (model minus NOAA):');
for (const [id, e] of Object.entries(report.homes)) {
  for (const model of ['era5', 'era5_land']) {
    const v = e.models[model]?.vsNoaa;
    if (!v) continue;
    log(`  ${(e.name || id).padEnd(20)} ${model.padEnd(10)} high ${String(v.tmax?.meanBias ?? '—').padStart(6)}°F   low ${String(v.tmin?.meanBias ?? '—').padStart(6)}°F   precip ${String(v.prcp?.meanBias ?? '—').padStart(6)} in`);
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report));
log(`\nWrote ${path.relative(ROOT, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);

const anyNoaa = Object.values(report.homes).some(e => e.noaa);
if (!anyNoaa) { console.error('\nNo NOAA station resolved for any home — comparison is model-vs-model only.'); process.exit(2); }

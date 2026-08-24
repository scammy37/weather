/* =============================================================================
   Why does Bonita Springs report 13 days a year at or above 90°F when the
   published figure for that area is around 90–115?

   The suspicion is that ERA5's ~17-mile grid cell mixes Gulf water into a
   coastal land point, damping the daily maximum by 2–3°F. That barely moves a
   monthly average but it devastates a THRESHOLD count, because 90°F sits in
   the fat middle of the summer distribution there: shift the whole curve down
   three degrees and most of the qualifying days fall below the line.

   Rather than argue about it, this measures every alternative that could
   plausibly fix it, over the SAME window, against real thermometer records:

     ghcn         NOAA GHCN-Daily station observations — not a model at all
     era5         what we publish today
     era5_land    land-only reanalysis, ~5.6 mile grid
     era5_ensemble
     ecmwf_ifs    ECMWF operational archive
     inland       era5, but at a point moved a few miles away from the water

   For each it reports days ≥90°F, ≥95°F, the July mean maximum, and how far
   each sits from the station observations. Rockaway and North Myrtle Beach are
   included as controls: a fix that only works for Florida is a coincidence.

   Run: node scripts/investigate-hotdays.mjs [--home bonita] [--out FILE]
   Needs network. Cheap: one variable over ten years weighs about 26 calls.
   =========================================================================== */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const cfg = require(path.join(ROOT, 'js/config.js'));
globalThis.MONTHS = cfg.MONTHS; globalThis.MONTHS_FULL = cfg.MONTHS_FULL;
globalThis.PERIODS = cfg.PERIODS;
const api = require(path.join(ROOT, 'js/api.js'));
api.setPacing(1500);

const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const onlyHome = argOf('--home', null);
const outPath = path.resolve(ROOT, argOf('--out', 'data/hotdays-investigation.json'));
const PERIOD = argOf('--period', cfg.DEFAULT_PERIOD);
const P = cfg.PERIODS[PERIOD];
const START = P.start, END = P.end;
const homes = cfg.LOCATIONS.filter(l => !onlyHome || l.id === onlyHome);

const log = (...m) => console.log(...m);
const F = (v, d = 1) => v == null ? '   —' : v.toFixed(d).padStart(6);

/* Stations near each home. Airports report continuously and are the records
   the published "days above 90" figures are themselves computed from. */
const STATIONS = {
  nmb:      ['USW00013717', 'USW00093718'],
  bonita:   ['USW00012897', 'USW00012835'],
  rockaway: ['USW00054743', 'USW00014734']
};

/* --- source 1: real thermometers ---------------------------------------- */
async function ghcnDaily(stationId) {
  const url = 'https://www.ncei.noaa.gov/access/services/data/v1'
    + `?dataset=daily-summaries&stations=${stationId}`
    + `&startDate=${START}&endDate=${END}&format=json&units=standard`
    + '&dataTypes=TMAX,TMIN';
  const res = await fetch(url, { headers: { 'User-Agent': 'tri-state-weather-dashboard (investigation)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows');
  const time = [], tmax = [], tmin = [];
  let name = stationId;
  for (const r of rows) {
    if (r.NAME) name = r.NAME;
    const hi = parseFloat(r.TMAX), lo = parseFloat(r.TMIN);
    time.push(r.DATE);
    tmax.push(Number.isFinite(hi) && hi > -900 ? hi : null);
    tmin.push(Number.isFinite(lo) && lo > -900 ? lo : null);
  }
  return { label: `ghcn ${stationId}`, name, time, tmax, tmin };
}

/* --- source 2: Open-Meteo archive, any named model and any point --------- */
async function archiveDaily(lat, lon, tz, model, label) {
  const url = `${api.API.archive}?latitude=${lat}&longitude=${lon}&timezone=${tz}`
    + `&start_date=${START}&end_date=${END}&daily=temperature_2m_max,temperature_2m_min`
    + '&temperature_unit=fahrenheit' + (model ? `&models=${model}` : '');
  const j = await api.apiGet(url, { label, retries: 1, timeout: 120000 });
  const d = j.daily || {};
  return { label, name: label, time: d.time || [],
           tmax: d.temperature_2m_max || [], tmin: d.temperature_2m_min || [] };
}

/* --- the statistics that actually disagree ------------------------------ */
function stats(series) {
  const years = new Set();
  let hot90 = 0, hot95 = 0, hot85 = 0, n = 0;
  const julHi = [], augHi = [], allHi = [];
  series.time.forEach((t, i) => {
    const v = series.tmax[i];
    if (v == null || !Number.isFinite(v)) return;
    years.add(t.slice(0, 4));
    n++;
    if (v >= 85) hot85++;
    if (v >= 90) hot90++;
    if (v >= 95) hot95++;
    const m = +t.slice(5, 7);
    if (m === 7) julHi.push(v);
    if (m === 8) augHi.push(v);
    allHi.push(v);
  });
  const y = years.size || 1;
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  /* Coverage matters: a station with gaps under-counts hot days purely by
     being switched off, which would look exactly like a cool bias. */
  const expected = Math.round((new Date(END) - new Date(START)) / 86400000) + 1;
  return {
    years: y, days: n, coverage: n / expected,
    hot85: hot85 / y, hot90: hot90 / y, hot95: hot95 / y,
    julMax: mean(julHi), augMax: mean(augHi), meanMax: mean(allHi)
  };
}

const report = { generated: new Date().toISOString(), period: PERIOD, window: `${START}…${END}`, homes: {} };

for (const loc of homes) {
  log(`\n\x1b[1m${loc.name}, ${loc.state}\x1b[0m  ${START}…${END}`);
  const sources = [];

  for (const id of STATIONS[loc.id] || []) {
    try { const s = await ghcnDaily(id); sources.push(s); log(`  ghcn ${id} — ${s.name}`); }
    catch (e) { log(`  ghcn ${id} unusable (${e.message})`); }
  }

  for (const model of ['era5', 'era5_land', 'era5_ensemble', 'ecmwf_ifs']) {
    try { sources.push(await archiveDaily(loc.lat, loc.lon, loc.tz, model, model)); }
    catch (e) { log(`  ${model} unusable (${e.message})`); }
  }

  /* A point moved away from the water, staying inside the same town where
     possible. If the problem is the grid cell rather than the model, this is
     the cheapest possible fix. */
  const inlandLon = loc.lon + (loc.id === 'bonita' ? 0.22 : loc.id === 'nmb' ? 0.22 : 0);
  const inlandLat = loc.lat + (loc.id === 'nmb' ? -0.05 : 0);
  if (inlandLon !== loc.lon || inlandLat !== loc.lat) {
    try {
      sources.push(await archiveDaily(inlandLat, inlandLon, loc.tz, 'era5',
        `era5 inland (${inlandLat.toFixed(2)}, ${inlandLon.toFixed(2)})`));
    } catch (e) { log(`  inland point unusable (${e.message})`); }
  }

  const rows = sources.map(s => ({ label: s.label, name: s.name, ...stats(s) }));
  const truth = rows.find(r => r.label.startsWith('ghcn') && r.coverage > 0.9)
             || rows.find(r => r.label.startsWith('ghcn'));

  log(`  ${'source'.padEnd(34)} ${'cover'.padStart(6)} ${'≥85'.padStart(6)} ${'≥90'.padStart(6)} ${'≥95'.padStart(6)} ${'JulMax'.padStart(7)} ${'vs obs'.padStart(8)}`);
  for (const r of rows) {
    const delta = truth && truth !== r && r.hot90 != null && truth.hot90 != null
      ? (r.hot90 - truth.hot90) : null;
    log(`  ${r.label.padEnd(34)} ${F(r.coverage * 100, 0)} ${F(r.hot85, 0)} ${F(r.hot90, 0)} ${F(r.hot95, 0)} ${F(r.julMax)} ${delta == null ? '     —' : F(delta, 0)}`);
  }
  if (truth) log(`  observations: ${truth.name} · ${Math.round(truth.coverage * 100)}% of days present`);
  report.homes[loc.id] = { name: `${loc.name}, ${loc.state}`, truth: truth ? truth.label : null, rows };
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
log(`\nWrote ${path.relative(ROOT, outPath)}\n`);

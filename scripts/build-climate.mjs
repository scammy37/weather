#!/usr/bin/env node
/* =============================================================================
   build-climate.mjs — precompute the monthly normals into data/climate.json.

   Why this exists
   ---------------
   Building the normals in the browser meant every visitor re-pulled 30 years of
   daily ERA5 records for three homes. Open-Meteo weights an API call roughly as
   (days / 14) x (variables / 10), which made a single page load cost about
   5,500 weighted calls against a 5,000/hour free-tier cap — so the page rate-
   limited itself.

   Doing it once, here, and committing the result drops a visitor's cost to the
   live feed alone: about 5 weighted calls.

   Usage
   -----
     node scripts/build-climate.mjs                  # every home, default period
     node scripts/build-climate.mjs --period all     # every period too (slow)
     node scripts/build-climate.mjs --home nmb
     node scripts/build-climate.mjs --period 1991-2020
     node scripts/build-climate.mjs --out data/climate.json

   Only the default normals period is built unless --period says otherwise:
   all three periods together come to roughly 13,000 weighted calls, over the
   10,000/day cap. The dashboard falls back to building a non-snapshot period
   live, and says so, so the alternates stay available without being paid for
   on every run.

   The fetch layer, variable lists and aggregation are imported from js/ rather
   than duplicated, so the committed data can never drift from what the page
   would have computed itself.
   =========================================================================== */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* js/*.js are plain scripts that talk to each other through globals, exactly as
   they do in the browser. Wiring them up the same way here keeps one source of
   truth for the variable lists and the aggregation rules. */
const cfg = require(path.join(ROOT, 'js/config.js'));
Object.assign(globalThis, {
  LOCATIONS: cfg.LOCATIONS, PERIODS: cfg.PERIODS, SST_PERIOD: cfg.SST_PERIOD,
  MONTHS: cfg.MONTHS, MONTHS_FULL: cfg.MONTHS_FULL, METRICS: cfg.METRICS,
  DEFAULT_PERIOD: cfg.DEFAULT_PERIOD
});
const solar = require(path.join(ROOT, 'js/solar.js'));
const api = require(path.join(ROOT, 'js/api.js'));
const climate = require(path.join(ROOT, 'js/climate.js'));

/* --- args --------------------------------------------------------------- */
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const onlyHome = argOf('--home', null);
const periodArg = argOf('--period', cfg.DEFAULT_PERIOD);
const onlyPeriod = periodArg === 'all' ? null : periodArg;
const outPath = path.resolve(ROOT, argOf('--out', 'data/climate.json'));

const homes = cfg.LOCATIONS.filter(l => !onlyHome || l.id === onlyHome);
const periods = Object.keys(cfg.PERIODS).filter(p => !onlyPeriod || p === onlyPeriod);
if (!homes.length) { console.error(`No home matches --home ${onlyHome}`); process.exit(1); }
if (!periods.length) { console.error(`No period matches --period ${onlyPeriod}`); process.exit(1); }

/* --- pacing -------------------------------------------------------------
   Open-Meteo weights a call as about (days / 14) x (variables / 10), and caps
   the free tier at 5,000/hour. A single 10-year, 17-variable chunk is worth
   roughly 440, so three homes for one period comes to about 5,500 — just over
   the hourly cap if fired off quickly. Spacing the requests out keeps the
   rolling hour under the limit. This runs unattended once a month, so the
   extra wall-clock time costs nothing.                                       */
const PAUSE_MS = +argOf('--pause', 90000);
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

const t0 = Date.now();
const log = (...m) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...m);

/* --- build --------------------------------------------------------------- */
const out = {
  generated: new Date().toISOString(),
  source: 'Open-Meteo — ECMWF ERA5 reanalysis (archive) and marine model (sea-surface temperature)',
  note: 'Precomputed by scripts/build-climate.mjs so the dashboard makes no archive requests at page load.',
  periods: cfg.PERIODS,
  sstPeriod: cfg.SST_PERIOD,
  homes: {}
};

let failures = 0;

for (const loc of homes) {
  out.homes[loc.id] = {};
  const sunClim = solar.monthlySunClimatology(loc.lat, loc.lon, loc.tz);

  /* Sea-surface temperature does not depend on the normals period, so it is
     fetched once per home and folded into each period's rows. */
  log(`${loc.name}: fetching ${cfg.SST_PERIOD.years} years of ocean data…`);
  let sstRows = [], sstInfo = { years: 0, mode: null, error: null };
  try {
    const marine = await api.fetchMarineArchive(loc, (done, total, label) => {
      if (done && done % 3 === 0) log(`  ocean ${done}/${total} — ${label}`);
    });
    sstRows = marine.rows;
    sstInfo = { years: marine.years, mode: marine.mode, error: null };
    log(`  ocean: ${sstRows.length} days over ${marine.years} years (${marine.mode} mode)`);
  } catch (err) {
    sstInfo.error = String(err && err.message || err);
    failures++;
    log(`  ocean FAILED: ${sstInfo.error}`);
  }

  for (const period of periods) {
    log(`${loc.name} · ${period}: fetching archive…`);
    await sleep(PAUSE_MS);
    try {
      const arch = await api.fetchArchive(loc, period, (done, total, label) =>
        log(`  ${done}/${total} — ${label}`));
      const rows = climate.aggregateMonthly(arch.daily, sunClim);
      if (!rows) throw new Error('archive returned no usable daily records');
      if (sstRows.length) climate.mergeSST(rows, sstRows);

      out.homes[loc.id][period] = {
        rows,
        annual: climate.annualSummary(rows),
        meta: {
          period, locId: loc.id,
          extended: arch.extended,
          sst: sstInfo,
          built: Date.now(),
          elevation: arch.meta && arch.meta.elevation
        }
      };
      const days = rows.reduce((s, r) => s + r.sampleDays, 0);
      log(`  ok — ${days.toLocaleString()} days aggregated, extended vars: ${arch.extended}`);
    } catch (err) {
      failures++;
      log(`  FAILED: ${String(err && err.message || err)}`);
    }
    await sleep(PAUSE_MS);
  }
}

/* --- write --------------------------------------------------------------- */
const built = Object.values(out.homes).reduce((s, h) => s + Object.keys(h).length, 0);
if (!built) {
  console.error('\nNothing was built — refusing to write an empty file.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);

log(`\nWrote ${path.relative(ROOT, outPath)} — ${built} home/period set${built === 1 ? '' : 's'}, ${kb} KB`);

const ok = api.DIAG.filter(d => d.status === 'ok').length;
const bad = api.DIAG.filter(d => d.status === 'fail').length;
log(`Requests: ${ok} succeeded, ${bad} failed`);
if (bad) for (const d of api.DIAG.filter(d => d.status === 'fail')) log(`  ✗ ${d.label} — ${d.note}`);

/* A partial build is still worth committing — it is strictly better than
   making every visitor fetch — but the exit code has to say so. */
process.exit(failures ? 2 : 0);
